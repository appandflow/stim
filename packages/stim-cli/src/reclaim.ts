import { type ProjectRecord, getProject, removeProject } from './config.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolveProjectMetro, killMetroTree, isPidAlive } from './metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd, type ParkedDevice, type ParkRequest } from './teardown.ts';
import { parkedMaxSetting } from './sim-pool.ts';
import { readCollectors } from './collector/state.ts';
import { verifyCollectorOwnership } from './collector/ownership.ts';
import {
  clearManagedMetroTunnel,
  clearRemoteSession,
  readMetroTunnel,
  readRemoteSessionId,
  readWorkspaceState,
  type ManagedTunnelRecord,
} from './supervisor/state.ts';
import { endRecordedSession } from './engine/device-remote.ts';
import { releaseWorkspaceLeases, type ReleasedLease } from './engine/device-lease.ts';
import { resolveEasCliBin } from './engine/remote-cache.ts';
import { stopTunnel, type StopTunnelResult } from './engine/tunnel.ts';
import { workspaceDir } from './paths.ts';
import { resolveSupervisorTarget } from './supervisor/ownership.ts';
import { sameProcessRecord, waitForProcessExit, type ProcessRecord } from './process-identity.ts';

async function reapCollectors(
  root: string,
  {
    verify = verifyCollectorOwnership,
  }: {
    verify?: typeof verifyCollectorOwnership;
  } = {},
): Promise<{ skippedDevices: SkippedDevice[]; failedDevices: SkippedDevice[] }> {
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];
  for (const [platform, record] of Object.entries(readCollectors(root))) {
    const rec = record as ProcessRecord | null;
    const pid = rec?.pid;
    if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || !isPidAlive(pid)) continue;
    const ownership = verify({ pid, platform, root, expected: rec });
    if (ownership.status === 'gone') continue;
    if (ownership.status === 'unverified') {
      const name = `${platform} log collector (pid ${pid})`;
      const platformLabel = platform === 'android' ? 'android' : 'ios';
      const entry: SkippedDevice = {
        platform: platformLabel,
        name,
        reason: `${ownership.reason}; keeping the record without signalling the process`,
      };
      skippedDevices.push(entry);
      failedDevices.push(entry);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      if (await waitForProcessExit(rec!, 5_000)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
    }
    const entry: SkippedDevice = {
      platform: platform === 'android' ? 'android' : 'ios',
      name: `${platform} log collector (pid ${pid})`,
      reason: 'Collector exit could not be confirmed; keeping its ownership record.',
    };
    skippedDevices.push(entry);
    failedDevices.push(entry);
  }
  return { skippedDevices, failedDevices };
}

// eas simulator:stop needs a project cwd, so end the session before removing the worktree.
function reclaimRemoteSession(
  root: string,
  { stopSession = defaultStopSession }: { stopSession?: StopSession } = {},
): { stopped: string | null; failed: SkippedDevice | null } {
  const sessionId = readRemoteSessionId(root);
  if (!sessionId) return { stopped: null, failed: null };
  let result: { status: 'torn-down' | 'failed'; reason?: string };
  try {
    result = stopSession(root, sessionId);
  } catch (err) {
    result = { status: 'failed', reason: String((err as Error)?.message ?? err) };
  }
  if (result.status === 'torn-down') {
    if (result.reason) {
      return {
        stopped: sessionId,
        failed: {
          platform: 'ios',
          name: `remote session ${sessionId}`,
          reason: `${result.reason} The session is stopped. Re-run cleanup to reconcile its retained ownership claim.`,
        },
      };
    }
    clearRemoteSession(root, sessionId);
    return { stopped: sessionId, failed: null };
  }
  return {
    stopped: null,
    failed: {
      platform: 'ios',
      name: `remote session ${sessionId}`,
      reason:
        `${result.reason ?? 'stop failed'} -- it keeps billing until its max duration. ` +
        `Stop it by hand from any directory of this project: eas simulator:stop --id ${sessionId}`,
    },
  };
}

type StopSession = (root: string, sessionId: string) => { status: 'torn-down' | 'failed'; reason?: string };

function defaultStopSession(root: string, sessionId: string) {
  return endRecordedSession({ root, sessionId, easBin: resolveEasCliBin(root)?.file ?? null });
}

type StopMetroTunnelFn = (record: ManagedTunnelRecord) => Promise<StopTunnelResult>;

function defaultStopMetroTunnel(record: ManagedTunnelRecord): Promise<StopTunnelResult> {
  return stopTunnel(record);
}

async function reclaimMetroTunnel(
  root: string,
  { stopMetroTunnel = defaultStopMetroTunnel }: { stopMetroTunnel?: StopMetroTunnelFn } = {},
): Promise<{ stopped: string | null; failed: SkippedDevice | null }> {
  const record = readMetroTunnel(root);
  if (record?.kind !== 'managed') return { stopped: null, failed: null };
  let result: StopTunnelResult;
  try {
    result = await stopMetroTunnel(record);
  } catch (err) {
    result = { status: 'failed', reason: String((err as Error)?.message ?? err) };
  }
  if (result.status === 'failed') {
    return {
      stopped: null,
      failed: {
        platform: 'ios',
        name: `${record.provider} tunnel (pid ${record.pid})`,
        reason:
          `${result.reason ?? 'stop failed'} The process identity could not be verified or the stop could not be confirmed. ` +
          'The ownership record is kept. Inspect the process and retry `stim worktree remove`.',
      },
    };
  }
  if (!clearManagedMetroTunnel(root, record)) {
    return {
      stopped: null,
      failed: {
        platform: 'ios',
        name: 'replacement managed tunnel',
        reason: 'A replacement managed tunnel record appeared during cleanup and is retained for a later stop.',
      },
    };
  }
  return { stopped: record.provider, failed: null };
}

interface SkippedDevice {
  platform: 'ios' | 'android';
  name: string;
  udid?: string;
  reason: string;
}

export function describeDereferenced(project: ProjectRecord | null): string[] {
  const devices: string[] = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) devices.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) devices.push(`android avd ${android.avdName}`);
  else if (android?.serial) devices.push(`android device ${android.serial}`);
  return devices;
}

export function parkedIosCacheKey(lastBuild: unknown): string | null {
  if (lastBuild === null || typeof lastBuild !== 'object' || Array.isArray(lastBuild)) return null;
  const build = lastBuild as Record<string, unknown>;
  return build.platform === 'ios' && typeof build.cacheKey === 'string' ? build.cacheKey : null;
}

function parkRequest(project: ProjectRecord | null, projectPath: string): ParkRequest | undefined {
  const { max, error } = parkedMaxSetting('ios');
  if (error || max <= 0) return undefined;
  const cacheKey = parkedIosCacheKey(readWorkspaceState(projectPath)?.lastBuild);
  return {
    projectPath,
    max,
    bundleId: typeof project?.bundleId === 'string' ? project.bundleId : null,
    cacheKey,
    simslimManaged: Boolean(project?.platforms?.ios?.simslimManaged),
  };
}

function reclaimOwnedDevices(
  project: ProjectRecord | null,
  projectPath: string,
  { park = false }: { park?: boolean } = {},
): {
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
} {
  const deletedDevices: string[] = [];
  const parkedDevices: ParkedDevice[] = [];
  const evictedDevices: ParkedDevice[] = [];
  const poolNotes: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    const udid = ios.deviceUdid as string;
    const label = (ios.deviceName as string | undefined) || udid;
    const r = teardownOwnedIosSim(udid, {
      del: true,
      label,
      ...(park ? { park: parkRequest(project, projectPath) } : {}),
    });
    if (r.parkFallback) poolNotes.push(`could not park ${label}: ${r.parkFallback} -- deleted it instead`);
    for (const failure of r.evictionFailures ?? []) poolNotes.push(failure);
    if (r.parked) {
      parkedDevices.push(r.parked);
      evictedDevices.push(...(r.evicted ?? []));
    } else if (r.status === 'torn-down') deletedDevices.push(r.label as string);
    if (r.status === 'skipped') {
      skippedDevices.push({ platform: 'ios', name: label, udid, reason: `${r.reason} -- not touched` });
    } else if (r.status === 'failed') {
      const entry: SkippedDevice = { platform: 'ios', name: label, udid, reason: `teardown failed: ${r.reason}` };
      skippedDevices.push(entry);
      failedDevices.push(entry);
    }
  }

  const android = project?.platforms?.android;
  if (android?.owned && android.avdName) {
    const r = teardownOwnedAvd(android.avdName, { del: true });
    if (r.status === 'torn-down') deletedDevices.push(android.avdName);
    else if (r.status === 'skipped') {
      skippedDevices.push({ platform: 'android', name: android.avdName, reason: `${r.reason} -- not touched` });
    } else if (r.status === 'failed') {
      const entry: SkippedDevice = {
        platform: 'android',
        name: android.avdName,
        reason: `teardown failed: ${r.reason}`,
      };
      skippedDevices.push(entry);
      failedDevices.push(entry);
    }
  }

  return { deletedDevices, parkedDevices, evictedDevices, poolNotes, skippedDevices, failedDevices };
}

export interface ReclaimResult {
  path: string;
  dereferenced: string[];
  killedPid: number | null;
  skippedMetro: string | null;
  metroPort: number | null;
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
  keptEntry: boolean;
  stoppedSession: string | null;
  stoppedTunnel: string | null;
  releasedLeases: ReleasedLease[];
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export async function reclaimProject(
  path: string,
  {
    deleteOwnedDevices = false,
    parkOwnedDevices = false,
    preserveProjectRecord = false,
    stopSession = defaultStopSession,
    stopMetroTunnel = defaultStopMetroTunnel,
    releaseLeases = releaseWorkspaceLeases,
    verifyCollector = verifyCollectorOwnership,
  }: {
    deleteOwnedDevices?: boolean;
    parkOwnedDevices?: boolean;
    preserveProjectRecord?: boolean;
    stopSession?: StopSession;
    stopMetroTunnel?: StopMetroTunnelFn;
    releaseLeases?: (root: string) => ReleasedLease[];
    verifyCollector?: typeof verifyCollectorOwnership;
  } = {},
): Promise<ReclaimResult> {
  const project = getProject(path);
  const dereferenced = describeDereferenced(project);
  const initialState = readWorkspaceState(path);

  let killedPid: number | null = null;
  let skippedMetro: string | null = null;
  let supervisorHeld = false;
  const supervisor = resolveSupervisorTarget({
    state: initialState?.supervisor,
    record: project?.supervisor,
    reservedPort: project?.metroPort,
  });
  if (supervisor.status === 'ours') {
    if (killMetroTree(supervisor.pid, supervisor.processToken) && (await waitForProcessExit(supervisor, 10_000))) {
      killedPid = supervisor.pid!;
    } else {
      skippedMetro = `could not confirm supervisor pid ${supervisor.pid} exited`;
      supervisorHeld = true;
    }
  } else if (supervisor.status === 'unverified') {
    skippedMetro = supervisor.reason ?? 'supervisor identity could not be verified';
    supervisorHeld = true;
  } else if (typeof project?.metroPort === 'number') {
    const resolution = await resolveProjectMetro(project.metroPort, path);
    if (!resolution.missing) skippedMetro = 'Externally started server left alone; no verified Stim supervisor owns it';
  }

  const { skippedDevices: skippedCollectors, failedDevices: failedCollectors } = await reapCollectors(path, {
    verify: verifyCollector,
  });

  const { deletedDevices, parkedDevices, evictedDevices, poolNotes, skippedDevices, failedDevices } =
    deleteOwnedDevices && !supervisorHeld && failedCollectors.length === 0
      ? reclaimOwnedDevices(project, path, { park: parkOwnedDevices })
      : {
          deletedDevices: [] as string[],
          parkedDevices: [] as ParkedDevice[],
          evictedDevices: [] as ParkedDevice[],
          poolNotes: [] as string[],
          skippedDevices: [] as SkippedDevice[],
          failedDevices: [] as SkippedDevice[],
        };
  skippedDevices.push(...skippedCollectors);
  failedDevices.push(...failedCollectors);

  const remote = reclaimRemoteSession(path, { stopSession });
  if (remote.failed) {
    skippedDevices.push(remote.failed);
    failedDevices.push(remote.failed);
  }

  const tunnel = await reclaimMetroTunnel(path, { stopMetroTunnel });
  if (tunnel.failed) {
    skippedDevices.push(tunnel.failed);
    failedDevices.push(tunnel.failed);
  }

  let releasedLeases: ReleasedLease[] = [];
  try {
    releasedLeases = releaseLeases(path);
  } catch {
    releasedLeases = [];
  }

  const currentState = readWorkspaceState(path);
  const replacement = Boolean(
    (currentState?.supervisor && !sameProcessRecord(currentState.supervisor, initialState?.supervisor)) ||
    (getProject(path)?.supervisor && !sameProcessRecord(getProject(path)?.supervisor, project?.supervisor)) ||
    Object.entries(currentState?.collectors ?? {}).some(
      ([platform, record]) =>
        !sameProcessRecord(record as ProcessRecord, initialState?.collectors?.[platform] as ProcessRecord | undefined),
    ),
  );
  if (replacement) {
    supervisorHeld = true;
    skippedMetro = 'A replacement process appeared during cleanup; its ownership records are retained';
  }

  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  if (failedDevices.length === 0 && !supervisorHeld) {
    const dir = workspaceDir(path);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removedWorkspaceDirs.push(dir);
      } catch {
        failedWorkspaceDirs.push(dir);
      }
    }
  }

  const keptEntry = supervisorHeld || failedDevices.length > 0 || failedWorkspaceDirs.length > 0;
  if (project && !keptEntry && !preserveProjectRecord) removeProject(path);

  return {
    path,
    dereferenced,
    killedPid,
    skippedMetro,
    metroPort: project?.metroPort ?? null,
    deletedDevices,
    parkedDevices,
    evictedDevices,
    poolNotes,
    skippedDevices,
    failedDevices,
    keptEntry,
    stoppedSession: remote.stopped,
    stoppedTunnel: tunnel.stopped,
    releasedLeases,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}
