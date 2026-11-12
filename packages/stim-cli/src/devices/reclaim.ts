import { endWorkspaceShares } from '../local-server.ts';
import type { StimContext } from '@stim-cli/core';
import { archiveWorkspace } from '../archive.ts';
import { clearNamedPorts } from '../named-ports.ts';
import { parseDeviceSlotKey, projectDeviceSlots } from './device-slots.ts';
import {
  type ProjectRecord,
  clearDevice,
  getProject,
  removeProject,
  withConfigLockAsync,
} from '../workspace/config.ts';
import { existsSync, realpathSync } from 'node:fs';
import { resolveProjectMetro, killMetroTreeAsync, pidExists, signalProcessTreeAsync } from '../metro.ts';
import { requestDevServerStop, withdrawDevServerStopRequest, type StopRequester } from '../stimd/metro/stop-cause.ts';
import {
  drainOwned,
  ensurePersistentStimd,
  stopDeviceLogStream,
  stopMetroTree,
  stopTunnelThroughStimd,
  workspaceManagedTunnel,
  type TunnelStop,
} from '../daemon/client.ts';
import { readBootedParkDeadline } from './booted-park.ts';
import {
  BROWSER_LOCK,
  teardownOwnedBrowser,
  teardownOwnedIosSim,
  teardownOwnedAvd,
  type ParkedDevice,
  type ParkRequest,
} from './teardown.ts';
import { acquireAvdClaim } from './avd-claim.ts';
import { waitForTreeExit } from '../process-group-exit.ts';
import { readClaimSet, releaseClaim } from '../ownership-claim.ts';
import { parkedMaxSetting } from './sim-pool.ts';
import { verifyCollectorOwnership } from '../stimd/logs/ownership.ts';
import { sameCollectorRecord } from '../stimd/logs/state.ts';
import {
  MODE_COMMAND,
  clearRemoteSession,
  readRemoteSessionId,
  type ManagedTunnelRecord,
} from '../stimd/metro/state.ts';
import { readWorkspaceState, withWorkspaceStateLockAsync } from '../workspace/workspace-state.ts';
import {
  isJsonObject,
  LAST_BUILD_KEYS,
  readMacosRecord,
  hostedNativeRecords,
  stimdClaimRoot,
} from '@stim-cli/core/state';
import { stopMacosApp } from '../macos/stop.ts';
import { macosAppPresent, macosAppStderr, macosAppStdout, macosLogFile } from '../macos/state.ts';
import { readWebRecord, webLogFile } from '../web/state.ts';
import { endRecordedSession } from '../engine/device-remote.ts';
import { releaseWorkspaceLeases, type ReleasedLease } from '../engine/device-lease.ts';
import { removePhoneReverses } from './phone-reverses.ts';
import { getExecutor } from '../exec.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { withWorkspaceProcessLock, WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { agentDeviceDaemon } from './activity.ts';
import { phaseLine } from '../command-output.ts';
import { workspaceAgentDeviceDir, workspaceDir } from '../workspace/paths.ts';
import { resolveSupervisorTarget } from '../stimd/metro/ownership.ts';
import { emptyWorkspaceDir, withIdleWorkspace } from '../workspace/in-use.ts';
import {
  inspectProcessIdentity,
  sameProcessRecord,
  waitForProcessExit,
  type ProcessRecord,
} from '../process-identity.ts';

function hasOwnedLogs(root: string): boolean {
  return (
    macosAppPresent(root) ||
    readWebRecord(root) !== null ||
    existsSync(macosLogFile(root)) ||
    existsSync(webLogFile(root))
  );
}

function hasLocalTail(root: string): boolean {
  const macos = readMacosRecord(root);
  return (
    !!macos?.app &&
    !macos.host &&
    macos.supervisor?.pid === macos.app.pid &&
    (existsSync(macosAppStdout(root, macos.launchId)) || existsSync(macosAppStderr(root, macos.launchId)))
  );
}

async function drainWorkspaceLogs(
  root: string,
  affected: boolean,
  localTail: boolean,
  operation: StimContext | undefined,
): Promise<void> {
  if (!affected) return;
  const claims = readClaimSet(stimdClaimRoot());
  if (!claims.live.length && !claims.unresolved.length && !localTail) return;
  const failure = await drainOwned(root, operation?.env);
  if (failure) throw new Error(`Could not drain workspace logs: ${failure}`);
}

function throwIfCleanupInterrupted(error: unknown, operation?: StimContext): void {
  if (error instanceof WorkspaceProcessCleanupError) throw error;
  operation?.signal.throwIfAborted();
}

async function reapCollectors(
  root: string,
  {
    verify = verifyCollectorOwnership,
    stopStream = stopDeviceLogStream,
    collectors,
    operation,
  }: {
    verify?: typeof verifyCollectorOwnership;
    stopStream?: typeof stopDeviceLogStream;
    collectors: Record<string, unknown>;
    operation?: StimContext;
  },
): Promise<{ skippedDevices: SkippedDevice[]; failedDevices: SkippedDevice[] }> {
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];
  for (const [platform, record] of Object.entries(collectors)) {
    operation?.signal.throwIfAborted();
    if (isJsonObject(record) && record.kind === 'stream') {
      const parsed = parseDeviceSlotKey(platform);
      const result =
        parsed && typeof record.streamId === 'string'
          ? await stopStream(root, parsed.platform, parsed.slot, record.streamId, operation)
          : { error: 'the stream identity is invalid' };
      if ('error' in result) {
        const entry: SkippedDevice = {
          platform: parsed?.platform ?? 'ios',
          name: `${platform} log stream`,
          reason: `${result.error}; keeping its ownership record`,
        };
        skippedDevices.push(entry);
        failedDevices.push(entry);
      }
      continue;
    }
    const rec = record as ProcessRecord | null;
    const pid = rec?.pid;
    if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || !pidExists(pid)) continue;
    const ownership = verify({ pid, platform, root, expected: rec });
    if (ownership.status === 'gone') continue;
    if (ownership.status === 'unverified') {
      const name = `${platform} log collector (pid ${pid})`;
      const platformLabel = platform.split(':')[0] === 'android' ? 'android' : 'ios';
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
      if (await waitForProcessExit(rec!, 5_000, operation?.signal)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
    }
    const entry: SkippedDevice = {
      platform: platform.split(':')[0] === 'android' ? 'android' : 'ios',
      name: `${platform} log collector (pid ${pid})`,
      reason: 'Collector exit could not be confirmed; keeping its ownership record.',
    };
    skippedDevices.push(entry);
    failedDevices.push(entry);
  }
  return { skippedDevices, failedDevices };
}

// eas simulator:stop needs a project cwd, so end the session before removing the worktree.
async function reclaimRemoteSession(
  root: string,
  { stopSession = defaultStopSession, operation }: { stopSession?: StopSession; operation?: StimContext } = {},
): Promise<{ stopped: string | null; failed: SkippedDevice | null }> {
  const sessionId = readRemoteSessionId(root);
  if (!sessionId) return { stopped: null, failed: null };
  let result: { status: 'torn-down' | 'failed'; reason?: string };
  try {
    result = await stopSession(root, sessionId, operation);
    operation?.signal.throwIfAborted();
  } catch (err) {
    throwIfCleanupInterrupted(err, operation);
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
    await withWorkspaceStateLockAsync(root, () => clearRemoteSession(root, sessionId));
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

type StopSession = (
  root: string,
  sessionId: string,
  operation?: StimContext,
) => { status: 'torn-down' | 'failed'; reason?: string } | Promise<{ status: 'torn-down' | 'failed'; reason?: string }>;

async function defaultStopSession(root: string, sessionId: string, operation?: StimContext) {
  const { resolveEasCliBin } = await import('../engine/remote-cache.ts');
  return endRecordedSession({ root, sessionId, easBin: resolveEasCliBin(root)?.file ?? null, operation });
}

type StopMetroTunnelFn = (
  root: string,
  record: ManagedTunnelRecord | null,
  operation?: StimContext,
) => Promise<TunnelStop>;

const defaultStopMetroTunnel: StopMetroTunnelFn = (root, record, operation) =>
  stopTunnelThroughStimd(root, record, operation?.signal);

async function reclaimMetroTunnel(
  root: string,
  {
    stopMetroTunnel = defaultStopMetroTunnel,
    operation,
  }: { stopMetroTunnel?: StopMetroTunnelFn; operation?: StimContext } = {},
): Promise<{ stopped: string | null; failed: SkippedDevice | null }> {
  const held = workspaceManagedTunnel(root);
  if (!held) return { stopped: null, failed: null };
  const { record, provider } = held;
  let result: TunnelStop;
  try {
    result = await stopMetroTunnel(root, record, operation);
    operation?.signal.throwIfAborted();
  } catch (err) {
    throwIfCleanupInterrupted(err, operation);
    result = { status: 'failed', reason: String((err as Error)?.message ?? err) };
  }
  if (result.status === 'failed') {
    return {
      stopped: null,
      failed: {
        platform: 'ios',
        name: record ? `${provider} tunnel (pid ${record.pid})` : `${provider} tunnel`,
        reason:
          `${result.reason || 'stop failed'} The process identity could not be verified or the stop could not be confirmed. ` +
          'The ownership record is kept. Inspect the process and retry `stim worktree remove`.',
      },
    };
  }
  return { stopped: provider, failed: null };
}

interface SkippedDevice {
  platform?: 'ios' | 'android';
  name: string;
  udid?: string;
  reason: string;
}

export function describeDereferenced(project: ProjectRecord | null): string[] {
  const devices: string[] = Object.entries(project?.ports ?? {}).map(([label, port]) => `port ${label} (${port})`);
  for (const { platforms } of projectDeviceSlots(project)) {
    const ios = platforms.ios;
    if (ios?.deviceUdid) devices.push(`ios sim ${ios.deviceUdid}`);
    const android = platforms.android;
    if (android?.avdName) devices.push(`android avd ${android.avdName}`);
    else if (android?.serial) devices.push(`android device ${android.serial}`);
  }
  return devices;
}

function lastBuildCacheKey(projectPath: string, platform: 'ios' | 'android'): string | null {
  const build = readWorkspaceState(projectPath)?.[LAST_BUILD_KEYS[platform]];
  if (!isJsonObject(build)) return null;
  const { cacheKey } = build;
  return typeof cacheKey === 'string' ? cacheKey : null;
}

function parkRequest(
  project: ProjectRecord | null,
  projectPath: string,
  slot: string,
  simslimManaged: boolean,
  bootedUntil: string | null,
): ParkRequest | undefined {
  const { max, error } = parkedMaxSetting('ios');
  if (error || max <= 0) return undefined;
  return {
    projectPath,
    max,
    simslimManaged,
    slot,
    appId: typeof project?.bundleId === 'string' ? project.bundleId : null,
    cacheKey: lastBuildCacheKey(projectPath, 'ios'),
    ...(bootedUntil ? { bootedUntil } : {}),
  };
}

async function reclaimOwnedDevices(
  project: ProjectRecord | null,
  projectPath: string,
  { park = false, operation }: { park?: boolean; operation?: StimContext } = {},
): Promise<{
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
}> {
  const deletedDevices: string[] = [];
  const parkedDevices: ParkedDevice[] = [];
  const evictedDevices: ParkedDevice[] = [];
  const poolNotes: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];

  for (const { slot, platforms } of projectDeviceSlots(project)) {
    operation?.signal.throwIfAborted();
    const ios = platforms.ios;
    if (ios?.owned && ios.deviceUdid) {
      const udid = ios.deviceUdid as string;
      const label = (ios.deviceName as string | undefined) || udid;
      const deadline = park ? await readBootedParkDeadline('ios', operation) : null;
      const bootedUntil = deadline && (await ensurePersistentStimd(operation?.env)) ? deadline : null;
      const r = await teardownOwnedIosSim(udid, {
        operation,
        del: true,
        label,
        ...(park ? { park: parkRequest(project, projectPath, slot, Boolean(ios.simslimManaged), bootedUntil) } : {}),
      });
      if (r.parkFallback) poolNotes.push(`could not park ${label}: ${r.parkFallback} -- deleted it instead`);
      for (const failure of r.evictionFailures ?? []) poolNotes.push(failure);
      if (r.parked) {
        parkedDevices.push(r.parked);
        evictedDevices.push(...(r.evicted ?? []));
      } else if (r.status === 'torn-down') deletedDevices.push(r.label as string);
      if (!r.parked && (r.status === 'torn-down' || r.status === 'missing')) {
        await withConfigLockAsync(() => clearDevice(projectPath, 'ios', slot, udid));
      }
      if (r.status === 'skipped') {
        skippedDevices.push({ platform: 'ios', name: label, udid, reason: `${r.reason} -- not touched` });
      } else if (r.status === 'failed') {
        const entry: SkippedDevice = { platform: 'ios', name: label, udid, reason: `teardown failed: ${r.reason}` };
        skippedDevices.push(entry);
        failedDevices.push(entry);
      }
    }

    const android = platforms.android;
    operation?.signal.throwIfAborted();
    if (android?.owned && android.avdName) {
      const bound = parkedMaxSetting('android');
      const r = await teardownOwnedAvd(android.avdName, {
        operation,
        del: true,
        owner: { projectPath, slot },
        ...(park && !bound.error && bound.max > 0
          ? {
              park: {
                projectPath,
                slot,
                max: bound.max,
                configuration: typeof android.poolConfiguration === 'string' ? android.poolConfiguration : undefined,
                appId: typeof project?.androidPackage === 'string' ? project.androidPackage : null,
                cacheKey: lastBuildCacheKey(projectPath, 'android'),
              },
            }
          : {}),
      });
      if (r.parkFallback) poolNotes.push(`could not park ${android.avdName}: ${r.parkFallback} -- deleted it instead`);
      for (const failure of r.evictionFailures ?? []) poolNotes.push(failure);
      if (!r.parked && (r.status === 'torn-down' || r.status === 'missing')) {
        const avdName = android.avdName;
        await withConfigLockAsync(() => clearDevice(projectPath, 'android', slot, avdName));
      }
      if (r.parked) {
        parkedDevices.push(r.parked);
        evictedDevices.push(...(r.evicted ?? []));
      } else if (r.status === 'torn-down') deletedDevices.push(android.avdName);
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

type ReclaimOptions = {
  operation?: StimContext;
  archive?: { removedBy: 'worktree-remove' | 'gc' | 'maintenance' };
  deleteOwnedDevices?: boolean;
  parkOwnedDevices?: boolean;
  preserveProjectRecord?: boolean;
  stopSession?: StopSession;
  stopMetroTunnel?: StopMetroTunnelFn;
  releaseLeases?: (root: string) => ReleasedLease[];
  verifyCollector?: typeof verifyCollectorOwnership;
  stopStream?: typeof stopDeviceLogStream;
  teardownBrowser?: typeof teardownOwnedBrowser;
  stopRequester?: StopRequester;
};

export async function reclaimProject(path: string, options: ReclaimOptions = {}): Promise<ReclaimResult> {
  const dir = workspaceDir(path);
  const existed = existsSync(dir);
  await endWorkspaceShares(path);
  const run = await withIdleWorkspace(path, () => reclaimIdleProject(path, existed, options), {
    operation: options.operation,
    purpose: 'workspace removal',
    hosted: false,
    supervisor: false,
    managedLocks: false,
  });
  if (run.ran) return run.value;
  const kept: SkippedDevice = { name: `workspace ${dir}`, reason: `kept because ${run.reasons.join('; ')}` };
  return {
    path,
    dereferenced: [],
    killedPid: null,
    skippedMetro: null,
    metroPort: getProject(path)?.metroPort ?? null,
    deletedDevices: [],
    parkedDevices: [],
    evictedDevices: [],
    poolNotes: [],
    skippedDevices: [kept],
    failedDevices: [kept],
    keptEntry: true,
    stoppedSession: null,
    stoppedTunnel: null,
    releasedLeases: [],
    removedWorkspaceDirs: [],
    failedWorkspaceDirs: [],
  };
}

function verifyAvdClaims(project: ProjectRecord | null, operation?: StimContext): void {
  for (const { platforms } of projectDeviceSlots(project)) {
    operation?.signal.throwIfAborted();
    if (platforms.android?.owned && platforms.android.avdName) {
      releaseClaim(acquireAvdClaim(platforms.android.avdName));
    }
  }
}

async function removeWorkspaceOutput(
  path: string,
  dir: string,
  archive: ReclaimOptions['archive'],
  state: ReturnType<typeof readWorkspaceState>,
  lockDir: string,
  operation?: StimContext,
): Promise<void> {
  const stateDir = workspaceAgentDeviceDir(path);
  if (agentDeviceDaemon(stateDir) !== 'none') {
    const exec = getExecutor();
    try {
      if (!exec.findExecutable('agent-device')) throw new Error('agent-device is not on PATH');
      await runOperationFile(operation, exec, 'agent-device', ['daemon', 'stop', '--state-dir', stateDir, '--clean'], {
        cwd: operation?.cwd,
        timeoutMs: 20_000,
        killSignal: 'SIGKILL',
        env: { AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
      });
    } catch (error) {
      throwIfCleanupInterrupted(error, operation);
      const message = `${phaseLine('agent-device', `daemon could not be stopped: ${(error as Error).message}; run agent-device daemon stop --state-dir "${stateDir}" --clean`)}\n`;
      if (operation) operation.output('stderr', message);
      else process.stderr.write(message);
      throw error;
    }
  }
  operation?.signal.throwIfAborted();
  if (archive) await archiveWorkspace(path, archive.removedBy, state, operation);
  if (realpathSync(dir) !== lockDir) throw new Error('Workspace storage changed during cleanup');
  await emptyWorkspaceDir(dir, operation?.signal, `${BROWSER_LOCK}.lock`);
}

async function reclaimIdleProject(
  path: string,
  workspaceExisted: boolean,
  {
    archive,
    deleteOwnedDevices = false,
    parkOwnedDevices = false,
    preserveProjectRecord = false,
    stopSession = defaultStopSession,
    stopMetroTunnel = defaultStopMetroTunnel,
    releaseLeases = releaseWorkspaceLeases,
    verifyCollector = verifyCollectorOwnership,
    stopStream,
    teardownBrowser = teardownOwnedBrowser,
    stopRequester = { by: 'stim gc' },
    operation,
  }: ReclaimOptions,
): Promise<ReclaimResult> {
  const signal = operation?.signal;
  signal?.throwIfAborted();
  await clearNamedPorts(
    path,
    operation ? { signal, log: (line) => operation.output('stderr', `${line}\n`) } : undefined,
  );
  signal?.throwIfAborted();
  const project = getProject(path);
  verifyAvdClaims(project, operation);
  const dereferenced = describeDereferenced(project);
  const initialState = readWorkspaceState(path);
  const ownedLogs = hasOwnedLogs(path);
  const localTail = hasLocalTail(path);
  await removePhoneReverses(path, { operation });

  let killedPid: number | null = null;
  let skippedMetro: string | null = null;
  let supervisorHeld = false;
  const supervisor = resolveSupervisorTarget({
    state: initialState?.supervisor,
    record: project?.supervisor,
    reservedPort: project?.metroPort,
  });
  const orphanServer = {
    pid: Number(initialState?.supervisor?.serverPid),
    processToken: initialState?.supervisor?.serverProcessToken,
  };
  const orphanIdentity =
    supervisor.status === 'stale' && typeof orphanServer.processToken === 'string'
      ? inspectProcessIdentity(orphanServer)
      : null;
  if (supervisor.status === 'ours') {
    const processToken = supervisor.processToken;
    await withWorkspaceStateLockAsync(path, () => requestDevServerStop(path, processToken, stopRequester)).catch(
      () => {},
    );
    const stopped = await stopMetroTree(
      path,
      supervisor.pid,
      supervisor.processToken,
      () => killMetroTreeAsync(supervisor.pid, supervisor.processToken, operation),
      signal,
    );
    if (!stopped.stopped)
      await withWorkspaceStateLockAsync(path, () => withdrawDevServerStopRequest(path, processToken)).catch(() => {});
    if (stopped.stopped && (await waitForTreeExit(supervisor, 10_000, signal))) {
      killedPid = supervisor.pid!;
    } else {
      skippedMetro = `could not confirm supervisor pid ${supervisor.pid} and its process group exited`;
      supervisorHeld = true;
    }
  } else if (supervisor.status === 'unverified') {
    skippedMetro = supervisor.reason ?? 'supervisor identity could not be verified';
    supervisorHeld = true;
  } else if (orphanIdentity === 'same') {
    let signalled = false;
    try {
      signalled = await signalProcessTreeAsync(orphanServer.pid, 'SIGTERM', {
        group: initialState?.supervisor?.mode === MODE_COMMAND,
        operation,
      });
    } catch (error) {
      throwIfCleanupInterrupted(error, operation);
    }
    const exited = signalled
      ? await waitForProcessExit(orphanServer, 10_000, signal)
      : ['gone', 'different'].includes(inspectProcessIdentity(orphanServer));
    if (exited) {
      killedPid = orphanServer.pid;
    } else {
      skippedMetro = `could not confirm dev server pid ${orphanServer.pid} left by the supervisor exited`;
      supervisorHeld = true;
    }
  } else if (orphanIdentity === 'unknown') {
    skippedMetro = `the identity of dev server pid ${orphanServer.pid} left by the supervisor could not be verified`;
    supervisorHeld = true;
  } else if (typeof project?.metroPort === 'number') {
    const resolution = await resolveProjectMetro(project.metroPort, path);
    if (!resolution.missing) skippedMetro = 'Externally started server left alone; no verified Stim supervisor owns it';
  }

  const { skippedDevices: skippedCollectors, failedDevices: failedCollectors } = await reapCollectors(path, {
    verify: verifyCollector,
    stopStream,
    collectors: initialState?.collectors ?? {},
    operation,
  });
  signal?.throwIfAborted();
  const browser = await teardownBrowser(path, { deleteProfile: true, operation });
  signal?.throwIfAborted();
  if (browser.status === 'failed' || browser.status === 'skipped') {
    const entry: SkippedDevice = { name: 'owned Chrome', reason: browser.reason ?? 'it could not be closed' };
    skippedCollectors.push(entry);
    failedCollectors.push(entry);
  }

  function retainReplacementProcesses() {
    const currentState = readWorkspaceState(path);
    const currentProject = getProject(path);
    const replacement = Boolean(
      (currentState?.supervisor && !sameProcessRecord(currentState.supervisor, initialState?.supervisor)) ||
      (currentProject?.supervisor && !sameProcessRecord(currentProject.supervisor, project?.supervisor)) ||
      readWebRecord(path) !== null ||
      Object.entries(currentState?.collectors ?? {}).some(
        ([platform, record]) => !sameCollectorRecord(record, initialState?.collectors?.[platform]),
      ),
    );
    if (replacement) {
      supervisorHeld = true;
      skippedMetro = 'A replacement process appeared during cleanup; its ownership records are retained';
    }
  }

  retainReplacementProcesses();

  const { deletedDevices, parkedDevices, evictedDevices, poolNotes, skippedDevices, failedDevices } =
    deleteOwnedDevices && !supervisorHeld && failedCollectors.length === 0
      ? await reclaimOwnedDevices(project, path, { park: parkOwnedDevices, operation })
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
  for (const platform of (['ios', 'android'] as const).filter(
    (kind) => Object.keys(hostedNativeRecords(readWorkspaceState(path), kind)).length > 0,
  )) {
    signal?.throwIfAborted();
    try {
      await (
        platform === 'ios'
          ? (await import('../device-host/hosted-ios.ts')).stopHostedIos
          : (await import('../device-host/hosted-android.ts')).stopHostedAndroid
      )(path, undefined, signal);
    } catch (error) {
      throwIfCleanupInterrupted(error, operation);
      const failed: SkippedDevice = { platform, name: `hosted ${platform} device`, reason: (error as Error).message };
      failedDevices.push(failed);
      skippedDevices.push(failed);
    }
  }

  signal?.throwIfAborted();
  const remote = await reclaimRemoteSession(path, { stopSession, operation });
  if (remote.failed) {
    skippedDevices.push(remote.failed);
    failedDevices.push(remote.failed);
  }

  if (macosAppPresent(path)) {
    signal?.throwIfAborted();
    const hosted = readMacosRecord(path)?.host;
    try {
      await stopMacosApp(path, operation);
    } catch (error) {
      throwIfCleanupInterrupted(error, operation);
      const failed = {
        name: hosted ? `hosted macOS session ${hosted.session} on ${hosted.machine}` : 'macOS app',
        reason: String((error as Error)?.message ?? error),
      };
      skippedDevices.push(failed);
      failedDevices.push(failed);
    }
  }

  signal?.throwIfAborted();
  const tunnel = await reclaimMetroTunnel(path, { stopMetroTunnel, operation });
  if (tunnel.failed) {
    skippedDevices.push(tunnel.failed);
    failedDevices.push(tunnel.failed);
  }

  let releasedLeases: ReleasedLease[] = [];
  signal?.throwIfAborted();
  try {
    releasedLeases = releaseLeases(path);
  } catch (error) {
    throwIfCleanupInterrupted(error, operation);
    releasedLeases = [];
  }

  retainReplacementProcesses();

  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  if (failedDevices.length === 0 && !supervisorHeld) {
    signal?.throwIfAborted();
    const dir = workspaceDir(path);
    if (existsSync(dir)) {
      try {
        const lockDir = realpathSync(dir);
        await withWorkspaceProcessLock(
          lockDir,
          BROWSER_LOCK,
          async () => {
            if (realpathSync(dir) !== lockDir) throw new Error('Workspace storage changed during cleanup');
            if (readWebRecord(path)) throw new Error('A replacement browser appeared during cleanup');
            await drainWorkspaceLogs(path, ownedLogs || hasOwnedLogs(path), localTail, operation);
            await removeWorkspaceOutput(path, dir, archive, initialState, lockDir, operation);
          },
          { external: true, waitMs: 0, ownerPurpose: 'workspace removal', signal, declareSpawnsFor: operation },
        );
        if (workspaceExisted) removedWorkspaceDirs.push(dir);
      } catch (error) {
        throwIfCleanupInterrupted(error, operation);
        failedWorkspaceDirs.push(dir);
      }
    }
  }

  const keptEntry = supervisorHeld || failedDevices.length > 0 || failedWorkspaceDirs.length > 0;
  signal?.throwIfAborted();
  if (project && !keptEntry && !preserveProjectRecord) await withConfigLockAsync(() => removeProject(path));

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
