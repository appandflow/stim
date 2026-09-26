import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import {
  NATIVE_RUN_LOCK,
  NATIVE_RUN_WAIT_MS,
  clearNativeRunCancel,
  decideStopAction,
  describeNativeRunHolder,
  nativeRunHolder,
  nativeRunWaitNotice,
  requestNativeRunCancel,
  type StopHolderAction,
} from '../engine/native-run.ts';
import { isClaimRefusal, type ClaimHolder } from '../ownership-claim.ts';
import { workspaceDir } from '../workspace/paths.ts';
import {
  deviceSlotPlatforms,
  parseDeviceSlotKey,
  parseDeviceSlotOption,
  projectDeviceSlots,
  validateDeviceSlot,
  WEB_SLOT,
} from '../devices/device-slots.ts';
import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, plural, refuseNoProject, releasedLeaseFact } from '../command-output.ts';
import { clearSupervisor, getProject, upsertProject, withConfigLock } from '../workspace/config.ts';
import type { ProjectRecord } from '../workspace/config.ts';
import { findCommandWorkspace } from '../workspace/project.ts';
import { pidExists, killMetroTree, resolveProjectMetro, signalProcessTree } from '../metro.ts';
import { logVanishedSupervisor, requestDevServerStop, withdrawDevServerStopRequest } from '../supervisor/stop-cause.ts';
import type { MetroResolution } from '../metro.ts';
import {
  clearManagedMetroTunnel,
  clearRemoteSession,
  readMetroTunnel,
  readRemoteSession,
  clearWorkspaceLaunches,
  clearWorkspaceSupervisor,
} from '../supervisor/state.ts';
import {
  clearWorkspaceStateKeys,
  readWorkspaceState,
  withWorkspaceStateLock,
  writeWorkspaceState,
} from '../workspace/workspace-state.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { teardownOwnedBrowser, teardownOwnedIosSim, teardownOwnedAvd } from '../devices/teardown.ts';
import { endRecordedSession } from '../engine/device-remote.ts';
import { fileLeaseIo, releaseWorkspaceLeases, type ReleasedLease } from '../engine/device-lease.ts';
import { resolveEasCliBin } from '../engine/remote-cache.ts';
import { stopTunnel } from '../engine/tunnel.ts';
import {
  inspectProcessIdentity,
  sameProcessRecord,
  waitForProcessExit,
  type ProcessRecord,
} from '../process-identity.ts';
import { resolveSupervisorTarget, type SupervisorTarget, type SupervisorStateRecord } from '../supervisor/ownership.ts';
export { resolveSupervisorTarget } from '../supervisor/ownership.ts';

const DEFAULT_WAIT_MS = 10_000;

interface CollectorStateRecord {
  pid?: number | string;
  [key: string]: unknown;
}

type CollectorStateMap = Record<string, CollectorStateRecord | undefined>;

interface TeardownResult {
  status: string;
  kind?: string;
  reason?: string;
  label?: string;
  serial?: string | null;
  holders?: string[];
}

export function readSupervisorState(root: string): SupervisorStateRecord | null {
  const sup = readWorkspaceState(root)?.supervisor;
  return sup && typeof sup === 'object' ? (sup as SupervisorStateRecord) : null;
}

export function readCollectorState(root: string): CollectorStateMap {
  const collectors = readWorkspaceState(root)?.collectors;
  return collectors && typeof collectors === 'object' ? (collectors as CollectorStateMap) : {};
}

interface RemoteDeviceRecord {
  platform?: string | null;
  sessionId?: string;
}
export function clearSupervisorState(root: string, expected?: ProcessRecord | null): boolean {
  return withWorkspaceStateLock(root, () => {
    if (!clearWorkspaceSupervisor(root, expected)) return false;
    clearWorkspaceStateKeys(root, ['launches']);
    return true;
  });
}

export function clearCollectorState(root: string, expected?: CollectorStateMap | null): boolean {
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const current = { ...state?.collectors };
    if (expected === undefined) {
      clearWorkspaceStateKeys(root, ['collectors']);
      return true;
    }
    for (const [platform, record] of Object.entries(expected ?? {})) {
      if (sameProcessRecord(current[platform] as ProcessRecord | undefined, record)) delete current[platform];
    }
    if (Object.keys(current).length) writeWorkspaceState(root, { collectors: current });
    else clearWorkspaceStateKeys(root, ['collectors']);
    return Object.keys(current).length === 0;
  });
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

interface CollectorTarget {
  platform: string;
  pid: number | null;
  status: string;
  reason?: string;
}

export function resolveCollectorTargets({
  root,
  collectors,
  isAlive = pidExists,
  selfPid = process.pid,
  verify = verifyCollectorOwnership,
}: {
  root: string;
  collectors?: CollectorStateMap | null;
  isAlive?: (pid: number) => boolean;
  selfPid?: number;
  verify?: typeof verifyCollectorOwnership;
}): CollectorTarget[] {
  const targets: CollectorTarget[] = [];
  for (const [platform, record] of Object.entries(collectors || {})) {
    const pid = numberOrNull(Number(record?.pid));
    if (!pid || pid === selfPid) {
      targets.push({ platform, pid: pid ?? null, status: 'invalid' });
      continue;
    }
    if (!isAlive(pid)) {
      targets.push({ platform, pid, status: 'stale' });
      continue;
    }
    const ownership = verify({ pid, platform, root, isAlive, expected: record });
    if (ownership.status === 'gone') {
      targets.push({ platform, pid, status: 'stale' });
      continue;
    }
    if (ownership.status === 'unverified') {
      targets.push({ platform, pid, status: 'unverified', reason: ownership.reason });
      continue;
    }
    targets.push({ platform, pid, status: 'running' });
  }
  return targets;
}

interface SupervisorOutcome {
  status: string;
  pid?: number;
  reason?: string;
  port?: number | null;
  mode?: string | null;
}

interface CollectorEntry {
  platform: string;
  pid: number | null;
  status: string;
  reason?: string;
}

interface CollectorsOutcome {
  status: string;
  entries: CollectorEntry[];
}

interface MetroOutcome {
  status: string;
  port?: number | null;
  pid?: number | null;
  reason?: string;
}

interface DeviceOutcomeEntry {
  status: string;
  label?: string;
  reason?: string;
  kind?: string | null;
  remedy?: string;
}

interface DeviceOutcome {
  [key: string]: DeviceOutcomeEntry | null | undefined;
  ios: DeviceOutcomeEntry | null;
  android: DeviceOutcomeEntry | null;
  remote?: DeviceOutcomeEntry | null;
  web?: DeviceOutcomeEntry | null;
}

interface PortOutcome {
  status: string;
  port?: number | null;
  reason?: string;
}

interface StopOutcomes {
  supervisor: SupervisorOutcome;
  collectors: CollectorsOutcome;
  metro: MetroOutcome;
  device: DeviceOutcome;
  port: PortOutcome;
  metroTunnel: TunnelOutcome;
  releasedLeases: ReleasedLease[];
}

interface TunnelOutcome {
  status: string;
  provider?: string;
  reason?: string;
}

function defaultTeardownRemoteSession(
  root: string,
  sessionId: string,
): { status: 'torn-down' | 'failed'; reason?: string } {
  return endRecordedSession({ root, sessionId, easBin: resolveEasCliBin(root)?.file ?? null });
}

function endRemoteSession(
  root: string,
  sessionId: string,
  {
    teardownRemoteSession,
    report,
  }: {
    teardownRemoteSession: (root: string, sessionId: string) => { status: 'torn-down' | 'failed'; reason?: string };
    report: (line: string) => void;
  },
): DeviceOutcomeEntry {
  const result = teardownRemoteSession(root, sessionId);
  if (result.status === 'failed') {
    report(chalk.red(phaseLine('device', result.reason ?? `could not stop remote session ${sessionId}`)));
  } else {
    report(chalk.dim(phaseLine('device', `stopped remote session ${sessionId}`)));
    if (result.reason) report(chalk.yellow(phaseLine('device', result.reason)));
    else clearRemoteSession(root, sessionId);
  }
  return { status: result.status, label: sessionId, reason: result.reason };
}

function remoteEnded(entry: DeviceOutcomeEntry): boolean {
  return entry.status !== 'failed' && !entry.reason;
}

type StopArgs = Parameters<typeof stopWorkspace>[0];

export async function runStop(options: StopArgs & { slot?: string }): ReturnType<typeof stopWorkspace> {
  if (options.slot === undefined) return stopWorkspace(options);
  if (options.slot === WEB_SLOT) return stopBrowserOnly(options);
  const slot = validateDeviceSlot(options.slot);
  const root = options.root;
  const project = options.project === undefined ? getProject(root) : options.project;
  const records = options.collectors === undefined ? readCollectorState(root) : options.collectors;
  const collectors = Object.fromEntries(
    Object.entries(records ?? {}).filter(([key]) => parseDeviceSlotKey(key)?.slot === slot),
  );
  const result = await stopWorkspace({
    ...options,
    project: project
      ? {
          ...project,
          platforms: deviceSlotPlatforms(project, slot),
          deviceSlots: undefined,
          supervisor: undefined,
          metroPort: null,
        }
      : null,
    state: null,
    collectors,
    remoteDevice: null,
    metroTunnel: null,
    clearCollectors: (projectRoot, expected) =>
      withWorkspaceStateLock(projectRoot, () => {
        clearCollectorState(projectRoot, expected);
        return !Object.keys(readCollectorState(projectRoot)).some((key) => parseDeviceSlotKey(key)?.slot === slot);
      }),
    clearState: (projectRoot) => {
      clearWorkspaceLaunches(projectRoot, slot);
      return true;
    },
    clearRegistration: async () => true,
    teardownBrowser: null,
    releaseLeases: (projectRoot) => releaseWorkspaceLeases(projectRoot, { slot }),
  });
  result.outcomes.port = {
    status: 'kept',
    port: project?.metroPort ?? null,
    reason: 'The workspace server is shared by all slots.',
  };
  result.outcomes.metro = { status: 'skipped', reason: 'The workspace server is shared by all slots.' };
  result.summary = summarize(root, result.outcomes, result.ok);
  return result;
}

async function stopBrowserOnly({
  root,
  project = undefined,
  teardownBrowser = (projectRoot: string) => teardownOwnedBrowser(projectRoot),
  report = (line: string) => console.error(line),
}: Pick<StopArgs, 'root' | 'project' | 'teardownBrowser' | 'report'>): ReturnType<typeof stopWorkspace> {
  const kept = 'Only the owned Chrome stops; the workspace server and devices keep running.';
  const port = (project === undefined ? getProject(root) : project)?.metroPort ?? null;
  const outcomes: StopOutcomes = {
    supervisor: { status: 'skipped', reason: kept },
    collectors: { status: 'skipped', entries: [] },
    metro: { status: 'skipped', reason: kept },
    device: { ios: null, android: null },
    port: port === null ? { status: 'none', port } : { status: 'kept', port, reason: kept },
    metroTunnel: { status: 'none' },
    releasedLeases: [],
  };
  outcomes.device.web = await closeBrowser(root, teardownBrowser, report);
  if (!outcomes.device.web) return { ok: true, outcomes, summary: `Stopped: no owned Chrome was running (${root})` };
  const ok = outcomes.device.web.status === 'shut-down';
  return { ok, outcomes, summary: summarize(root, outcomes, ok) };
}

async function stopWorkspace({
  root,
  project = undefined,
  state = undefined,
  collectors = undefined,
  signalCollector = (pid: number) => signalProcessTree(pid),
  verifyCollector = verifyCollectorOwnership,
  clearCollectors = clearCollectorState,
  isAlive = pidExists,
  killGroup = killMetroTree,
  signalServer = (pid: number) => signalProcessTree(pid),
  inspectIdentity = inspectProcessIdentity,
  waitForDeath = undefined,
  waitMs = DEFAULT_WAIT_MS,
  resolveMetro = resolveProjectMetro,
  teardownIos = teardownOwnedIosSim,
  teardownAvd = teardownOwnedAvd,
  teardownBrowser = (projectRoot: string) => teardownOwnedBrowser(projectRoot),
  remoteDevice = undefined,
  teardownRemoteSession = defaultTeardownRemoteSession,
  metroTunnel = undefined,
  stopMetroTunnel = stopTunnel,
  releaseLeases = releaseWorkspaceLeases,
  freePort = defaultFreePort,
  clearRegistration = defaultClearRegistration,
  clearState = clearSupervisorState,
  report = (line: string) => console.error(line),
}: {
  root: string;
  project?: ProjectRecord | null;
  state?: SupervisorStateRecord | null;
  collectors?: CollectorStateMap | null;
  signalCollector?: (pid: number) => void;
  verifyCollector?: typeof verifyCollectorOwnership;
  clearCollectors?: (root: string, expected?: CollectorStateMap | null) => boolean | void;
  isAlive?: (pid: number) => boolean;
  killGroup?: typeof killMetroTree;
  signalServer?: (pid: number) => boolean;
  inspectIdentity?: typeof inspectProcessIdentity;
  waitForDeath?: ((pid: number) => Promise<boolean>) | undefined;
  waitMs?: number;
  resolveMetro?: (port: number, root: string) => Promise<MetroResolution>;
  teardownIos?: (udid: string, opts: { del?: boolean; label?: string; workspace?: string }) => TeardownResult;
  teardownAvd?: (avdName: string, opts: { del?: boolean; workspace?: string }) => TeardownResult;
  teardownBrowser?: ((root: string) => Promise<TeardownResult>) | null;
  remoteDevice?: RemoteDeviceRecord | null;
  metroTunnel?: ReturnType<typeof readMetroTunnel> | undefined;
  stopMetroTunnel?: typeof stopTunnel;
  releaseLeases?: (root: string) => ReleasedLease[];
  teardownRemoteSession?: (root: string, sessionId: string) => { status: 'torn-down' | 'failed'; reason?: string };
  freePort?: (root: string, port: number) => boolean | void;
  clearRegistration?: (root: string, expected?: ProcessRecord | null) => Promise<boolean | void>;
  clearState?: (root: string, expected?: ProcessRecord | null) => boolean | void;
  report?: (line: string) => void;
}): Promise<{ ok: boolean; outcomes: StopOutcomes; summary: string }> {
  const proj = project === undefined ? getProject(root) : project;
  const sup = state === undefined ? readSupervisorState(root) : state;
  const collectorRecords = collectors === undefined ? readCollectorState(root) : collectors;
  const reservedPort = typeof proj?.metroPort === 'number' ? proj.metroPort : null;
  const waiter =
    waitForDeath ?? ((pid: number, processToken?: string) => waitForProcessExit({ pid, processToken }, waitMs));

  const outcomes: StopOutcomes = {
    supervisor: { status: 'none' },
    collectors: { status: 'none', entries: [] },
    metro: { status: 'none' },
    device: { ios: null, android: null },
    port: { status: 'none', port: reservedPort },
    metroTunnel: { status: 'none' },
    releasedLeases: [],
  };
  let ok = true;
  let stillHolding: string | null | undefined = null;
  let keepPort: string | null = null;

  const target = resolveSupervisorTarget({
    state: sup,
    record: proj?.supervisor ?? null,
    reservedPort,
    isAlive,
    inspectIdentity,
  });
  if (target.status === 'none') {
    report(chalk.dim(phaseLine('stop', 'no supervisor recorded')));
  } else if (target.status === 'stale') {
    logVanishedSupervisor(root, sup);
    outcomes.supervisor = {
      status: 'already-stopped',
      pid: target.pid,
      reason: `recorded pid ${target.pid} is not running`,
    };
    report(chalk.dim(phaseLine('stop', `supervisor pid ${target.pid} is already gone (stale record)`)));
  } else if (target.status === 'unverified') {
    outcomes.supervisor = { status: 'unverified', pid: target.pid, reason: target.reason };
    report(chalk.yellow(phaseLine('stop', `refusing to signal supervisor pid ${target.pid}: ${target.reason}`)));
    ok = false;
    stillHolding = `supervisor pid ${target.pid} could not be verified`;
  } else {
    outcomes.supervisor = await stopSupervisor(target, { root, killGroup, waiter, report });
    if (outcomes.supervisor.status !== 'stopped') {
      ok = false;
      stillHolding = outcomes.supervisor.reason;
    }
  }

  outcomes.collectors = await reapCollectors(root, collectorRecords, {
    isAlive,
    signal: signalCollector,
    report,
    verify: verifyCollector,
    waiter,
  });
  const unverifiedCollectors = outcomes.collectors.entries.filter((e) => e.status === 'unverified');
  if (unverifiedCollectors.length) {
    report(
      chalk.dim(
        phaseLine(
          'stop',
          `keeping the collector records; ${plural(unverifiedCollectors.length, 'pid')} could not be verified, and a later \`ios\` / \`android\` run replaces them`,
        ),
      ),
    );
    ok = false;
    stillHolding ??= 'collector process identity could not be verified';
  } else if (outcomes.collectors.entries.some((entry) => entry.status === 'failed')) {
    ok = false;
    stillHolding ??= 'a collector could not be stopped';
  } else if (outcomes.collectors.entries.length && clearCollectors(root, collectorRecords) === false) {
    ok = false;
    stillHolding ??= 'a replacement collector appeared during cleanup';
  }

  const supervisorHandled =
    outcomes.supervisor.status === 'stopped' ||
    outcomes.supervisor.status === 'timeout' ||
    outcomes.supervisor.status === 'unverified' ||
    outcomes.supervisor.status === 'failed';
  if (supervisorHandled) {
    outcomes.metro = { status: 'skipped', reason: 'the supervisor owns the dev server on this port' };
  } else if (reservedPort === null) {
    report(chalk.dim(phaseLine('metro', 'no port reserved')));
  } else {
    const metro = await stopMetro(reservedPort, root, {
      server: sup,
      supervisorGone: target.status === 'stale',
      signalServer,
      inspectIdentity,
      waiter,
      resolveMetro,
      report,
    });
    outcomes.metro = metro.outcome;
    keepPort = metro.keepPort;
    if (outcomes.metro.status === 'refused' || outcomes.metro.status === 'failed') {
      ok = false;
      stillHolding = outcomes.metro.reason;
    }
  }

  const releaseStoppedSupervisor = async () => {
    const stateCleared = clearState(root, sup);
    const registrationCleared = await clearRegistration(root, proj?.supervisor ?? null);
    if (stateCleared === false || registrationCleared === false) {
      ok = false;
      outcomes.port = {
        status: 'kept',
        port: reservedPort,
        reason: 'a replacement supervisor appeared during cleanup',
      };
      return;
    }
    if (reservedPort !== null) {
      if (keepPort) {
        outcomes.port = { status: 'kept', port: reservedPort, reason: keepPort };
        report(chalk.dim(phaseLine('port', `keeping reservation ${reservedPort} -- ${keepPort}`)));
        return;
      }
      if (freePort(root, reservedPort) === false) {
        ok = false;
        outcomes.port = { status: 'kept', port: reservedPort, reason: 'the port reservation changed during cleanup' };
        return;
      }
      outcomes.port = { status: 'freed', port: reservedPort };
      report(chalk.dim(phaseLine('port', `released ${reservedPort}`)));
    }
  };

  if (stillHolding) {
    report(chalk.dim(phaseLine('device', 'left alone (something is still running)')));
  } else {
    outcomes.device = shutDownDevices(proj, root, { teardownIos, teardownAvd, report });
    if (Object.values(outcomes.device).some((device) => device?.status === 'failed')) ok = false;
  }

  outcomes.device.web = await closeBrowser(root, teardownBrowser, report);
  if (outcomes.device.web && outcomes.device.web.status !== 'shut-down') ok = false;

  const remote = remoteDevice === undefined ? readRemoteSession(root) : remoteDevice;
  const sessionId = typeof remote?.sessionId === 'string' ? remote.sessionId : null;
  if (sessionId) {
    outcomes.device.remote = endRemoteSession(root, sessionId, { teardownRemoteSession, report });
    if (!remoteEnded(outcomes.device.remote)) ok = false;
  }

  const tunnel = metroTunnel === undefined ? readMetroTunnel(root) : metroTunnel;
  let tunnelHolding: string | null = null;
  if (tunnel?.kind === 'managed') {
    const result = await stopMetroTunnel(tunnel);
    outcomes.metroTunnel = { status: result.status, provider: tunnel.provider, reason: result.reason };
    if (result.status === 'failed') {
      ok = false;
      tunnelHolding = result.reason ?? `could not stop the ${tunnel.provider} tunnel`;
      if (!stillHolding) stillHolding = tunnelHolding;
      report(chalk.red(phaseLine('lan', tunnelHolding)));
    } else {
      if (!clearManagedMetroTunnel(root, tunnel)) {
        tunnelHolding = 'a replacement managed tunnel record appeared during cleanup and remains active';
        stillHolding = stillHolding ?? tunnelHolding;
        ok = false;
        outcomes.metroTunnel = { status: 'failed', provider: tunnel.provider, reason: tunnelHolding };
        report(chalk.red(phaseLine('lan', tunnelHolding)));
      } else {
        report(
          chalk.dim(
            phaseLine(
              'lan',
              result.status === 'missing' ? 'tunnel already gone' : `stopped the ${tunnel.provider} tunnel`,
            ),
          ),
        );
      }
    }
  } else if (tunnel?.kind === 'expo') {
    outcomes.metroTunnel = { status: 'not-managed' };
  }

  outcomes.releasedLeases = releaseLeases(root);
  for (const lease of outcomes.releasedLeases) {
    report(chalk.dim(phaseLine('lease', releasedLeaseFact(lease))));
  }

  if (stillHolding) {
    outcomes.port = { status: 'kept', port: reservedPort, reason: stillHolding };
    report(chalk.yellow(phaseLine('port', `keeping reservation ${reservedPort ?? '(none)'} -- ${stillHolding}`)));
    const serverIsDown =
      ['none', 'already-stopped', 'stopped'].includes(outcomes.supervisor.status) &&
      !['refused', 'failed'].includes(outcomes.metro.status);
    if (tunnelHolding && serverIsDown) {
      clearState(root, sup);
      await clearRegistration(root, proj?.supervisor ?? null);
    }
  } else {
    await releaseStoppedSupervisor();
  }

  return { ok, outcomes, summary: summarize(root, outcomes, ok) };
}

async function reapCollectors(
  root: string,
  collectors: CollectorStateMap | null | undefined,
  {
    isAlive,
    signal,
    report,
    verify = verifyCollectorOwnership,
    waiter,
  }: {
    isAlive: (pid: number) => boolean;
    signal: (pid: number) => void;
    report: (line: string) => void;
    verify?: typeof verifyCollectorOwnership;
    waiter: (pid: number, processToken?: string) => Promise<boolean>;
  },
): Promise<CollectorsOutcome> {
  const targets = resolveCollectorTargets({ root, collectors, isAlive, verify });
  const entries: CollectorEntry[] = [];
  for (const target of targets) {
    if (target.status === 'invalid') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'invalid' });
      report(chalk.dim(phaseLine('stop', `ignoring an unusable ${target.platform} collector record`)));
      continue;
    }
    if (target.status === 'stale') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'already-stopped' });
      report(chalk.dim(phaseLine('stop', `collector ${target.platform} pid ${target.pid} is already gone`)));
      continue;
    }
    if (target.status === 'unverified') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'unverified', reason: target.reason });
      report(
        chalk.yellow(
          phaseLine('stop', `refusing to signal collector ${target.platform} pid ${target.pid}: ${target.reason}`),
        ),
      );
      continue;
    }
    try {
      const ownership = verify({
        pid: target.pid as number,
        platform: target.platform,
        root,
        isAlive,
        expected: collectors?.[target.platform],
      });
      if (ownership.status !== 'ours') {
        entries.push({
          platform: target.platform,
          pid: target.pid,
          status: ownership.status === 'gone' ? 'already-stopped' : 'unverified',
          ...(ownership.status === 'unverified' ? { reason: ownership.reason } : {}),
        });
        continue;
      }
      signal(target.pid as number);
      if (!(await waiter(target.pid as number, collectors?.[target.platform]?.processToken as string | undefined))) {
        entries.push({
          platform: target.platform,
          pid: target.pid,
          status: 'failed',
          reason: 'collector exit could not be confirmed',
        });
        continue;
      }
      entries.push({ platform: target.platform, pid: target.pid, status: 'stopped' });
      report(chalk.green(phaseLine('stop', `collector ${target.platform} pid ${target.pid}`)));
    } catch (error) {
      const gone = (error as NodeJS.ErrnoException).code === 'ESRCH';
      entries.push({ platform: target.platform, pid: target.pid, status: gone ? 'already-stopped' : 'failed' });
      report(
        chalk.dim(
          phaseLine(
            'stop',
            gone
              ? `collector ${target.platform} pid ${target.pid} exited before it could be signalled`
              : `could not signal collector ${target.platform} pid ${target.pid}`,
          ),
        ),
      );
    }
  }
  if (entries.length === 0) {
    report(chalk.dim(phaseLine('stop', 'no collectors recorded')));
    return { status: 'none', entries };
  }
  return { status: 'stopped', entries };
}

async function stopSupervisor(
  target: SupervisorTarget,
  {
    root,
    killGroup,
    waiter,
    report,
  }: {
    root: string;
    killGroup: typeof killMetroTree;
    waiter: (pid: number, processToken?: string) => Promise<boolean>;
    report: (line: string) => void;
  },
): Promise<SupervisorOutcome> {
  report(chalk.dim(phaseLine('stop', `sending SIGTERM to supervisor process group ${target.pid}`)));
  requestDevServerStop(root, target.processToken, { by: 'stim stop' });
  let signalled = false;
  try {
    signalled = killGroup(target.pid, target.processToken);
  } catch (e) {
    signalled = false;
    report(
      chalk.red(
        phaseLine('stop', `could not signal supervisor pid ${target.pid}: ${String((e as Error)?.message || e)}`),
      ),
    );
  }
  if (!signalled) {
    withdrawDevServerStopRequest(root, target.processToken);
    const reason = `could not signal supervisor pid ${target.pid}`;
    report(chalk.red(phaseLine('stop', reason)));
    return { status: 'failed', pid: target.pid, port: target.port ?? null, reason };
  }
  const died = await waiter(target.pid as number, target.processToken);
  if (died) {
    report(chalk.green(phaseLine('stop', `supervisor pid ${target.pid}`)));
    return { status: 'stopped', pid: target.pid, port: target.port ?? null, mode: target.mode ?? null };
  }
  const reason = `supervisor pid ${target.pid} did not exit within ${Math.round(DEFAULT_WAIT_MS / 1000)}s of SIGTERM`;
  report(chalk.red(phaseLine('stop', reason)));
  report(
    chalk.dim(phaseLine('', `inspect it with \`ps -p ${target.pid}\`, or signal it yourself: kill -9 -${target.pid}`)),
  );
  return { status: 'timeout', pid: target.pid, port: target.port ?? null, reason };
}

async function stopMetro(
  port: number,
  root: string,
  {
    server,
    supervisorGone,
    signalServer,
    inspectIdentity,
    waiter,
    resolveMetro,
    report,
  }: {
    server: SupervisorStateRecord | null;
    supervisorGone: boolean;
    signalServer: (pid: number) => boolean;
    inspectIdentity: typeof inspectProcessIdentity;
    waiter: (pid: number, processToken?: string) => Promise<boolean>;
    resolveMetro: (port: number, root: string) => Promise<MetroResolution>;
    report: (line: string) => void;
  },
): Promise<{ outcome: MetroOutcome; keepPort: string | null }> {
  const serverPid = numberOrNull(server?.serverPid);
  const serverProcessToken = server?.serverProcessToken;
  const serverRecord = { pid: serverPid, processToken: serverProcessToken };
  const identity =
    supervisorGone && serverPid && typeof serverProcessToken === 'string' ? inspectIdentity(serverRecord) : null;
  if (identity === 'unknown') {
    const reason = `the identity of dev server pid ${serverPid} left by the supervisor could not be verified`;
    report(chalk.yellow(phaseLine('metro', `refusing to signal it: ${reason}`)));
    return { outcome: { status: 'refused', port, pid: serverPid, reason }, keepPort: null };
  }
  if (identity === 'same') {
    report(chalk.dim(phaseLine('metro', `sending SIGTERM to dev server pid ${serverPid} left by the supervisor`)));
    let signalled = false;
    try {
      signalled = signalServer(serverPid as number);
    } catch {}
    const exited = signalled
      ? await waiter(serverPid as number, serverProcessToken as string)
      : ['gone', 'different'].includes(inspectIdentity(serverRecord));
    if (exited) {
      report(chalk.green(phaseLine('metro', `dev server pid ${serverPid}`)));
      return { outcome: { status: 'stopped', port, pid: serverPid }, keepPort: null };
    }
    const reason = `dev server pid ${serverPid} left by the supervisor did not exit`;
    report(chalk.red(phaseLine('metro', reason)));
    return { outcome: { status: 'failed', port, pid: serverPid, reason }, keepPort: null };
  }
  const resolution = await resolveMetro(port, root);
  if (resolution.missing) {
    report(chalk.dim(phaseLine('metro', `nothing listening on port ${port}`)));
    return { outcome: { status: 'missing', port }, keepPort: null };
  }
  const reason =
    resolution.notOurs || 'no recorded Stim supervisor owns this server; stop it with the tool that started it';
  report(chalk.yellow(phaseLine('metro', `leaving port ${port} alone: ${reason}`)));
  return {
    outcome: { status: 'not-managed', port, reason },
    keepPort: resolution.metro ? `a dev server from this project still answers on port ${port}` : null,
  };
}

const OCCUPANCY_HINT = 'often a UI-test runner or device tool still attached';

function occupiedSkipReason(reason: string, holders: string[] | null | undefined): string {
  const named = (holders || []).filter(Boolean);
  return named.length ? `${reason} -- held by UI-test runner ${named.join(', ')}` : `${reason} -- ${OCCUPANCY_HINT}`;
}

function shutDownDevices(
  project: ProjectRecord | null | undefined,
  workspace: string,
  {
    teardownIos,
    teardownAvd,
    report,
  }: {
    teardownIos: (udid: string, opts: { del?: boolean; label?: string; workspace?: string }) => TeardownResult;
    teardownAvd: (avdName: string, opts: { del?: boolean; workspace?: string }) => TeardownResult;
    report: (line: string) => void;
  },
): DeviceOutcome {
  const device: DeviceOutcome = { ios: null, android: null };

  for (const { slot, platforms } of projectDeviceSlots(project)) {
    const iosKey = slot === 'default' ? 'ios' : `ios:${slot}`;
    const androidKey = slot === 'default' ? 'android' : `android:${slot}`;
    const ios = platforms.ios;
    const iosUdid = ios?.deviceUdid as string | undefined;
    const iosName = ios?.deviceName as string | undefined;
    if (iosUdid) {
      if (!ios?.owned) {
        device[iosKey] = {
          status: 'skipped',
          kind: 'not-owned',
          label: iosUdid,
          reason: 'Stim does not own this device',
        };
        report(chalk.dim(phaseLine('device', `${iosUdid} is not Stim-owned, leaving it running`)));
      } else {
        device[iosKey] = reportDevice(
          iosUdid,
          teardownIos(iosUdid, { del: false, label: iosName, workspace }),
          report,
          'ios',
        );
      }
    }

    const android = platforms.android;
    if (android?.avdName) {
      if (!android.owned) {
        device[androidKey] = {
          status: 'skipped',
          kind: 'not-owned',
          label: android.avdName,
          reason: 'Stim does not own this device',
        };
        report(chalk.dim(phaseLine('device', `${android.avdName} is not Stim-owned, leaving it running`)));
      } else {
        device[androidKey] = reportDevice(
          android.avdName,
          teardownAvd(android.avdName, { del: false, workspace }),
          report,
          'android',
        );
      }
    }
  }
  return device;
}

function deviceShutdownRemedy(kind: 'ios' | 'android', label: string): string {
  return kind === 'ios'
    ? `check it with \`xcrun simctl list devices\`, then \`xcrun simctl shutdown ${label}\` yourself -- if it will not respond, \`stim gc --delete\` reclaims it`
    : `check it with \`adb devices\`, then \`adb -s <serial> emu kill\` yourself -- if it will not respond, \`stim gc --delete\` reclaims it`;
}

function reportDevice(
  label: string,
  r: TeardownResult,
  report: (line: string) => void,
  kind: 'ios' | 'android',
): DeviceOutcomeEntry {
  if (r.status === 'torn-down') {
    report(chalk.green(phaseLine('device', `shut down ${r.label ?? label}`)));
    return { status: 'shut-down', label: r.label ?? label };
  }
  if (r.status === 'missing') {
    report(chalk.dim(phaseLine('device', `${label} is already gone`)));
    return { status: 'missing', label };
  }
  if (r.status === 'skipped') {
    const reason = r.kind === 'occupied' ? occupiedSkipReason(r.reason as string, r.holders) : r.reason;
    report(chalk.yellow(phaseLine('device', `skipped ${label}: ${reason}`)));
    return { status: 'skipped', kind: r.kind ?? null, label, reason };
  }
  const remedy = deviceShutdownRemedy(kind, r.label ?? label);
  report(chalk.red(phaseLine('device', `failed to shut down ${r.label ?? label}: ${r.reason}`)));
  report(chalk.dim(phaseLine('', remedy)));
  return { status: 'failed', label: r.label ?? label, reason: r.reason, remedy };
}

async function closeBrowser(
  root: string,
  teardownBrowser: ((root: string) => Promise<TeardownResult>) | null,
  report: (line: string) => void,
): Promise<DeviceOutcomeEntry | null> {
  if (!teardownBrowser) return null;
  const r = await teardownBrowser(root);
  if (r.status === 'missing') return null;
  if (r.status === 'torn-down') {
    report(chalk.green(phaseLine('device', `closed ${r.label}; its profile is kept`)));
    return { status: 'shut-down', label: 'Chrome' };
  }
  const remedy = 'run `stim status`, then `stim guide errors teardown`';
  report(chalk.red(phaseLine('device', `did not close the owned Chrome: ${r.reason}`)));
  report(chalk.dim(phaseLine('', remedy)));
  return { status: r.status, kind: r.kind ?? null, label: 'Chrome', reason: r.reason, remedy };
}

function summarize(root: string, outcomes: StopOutcomes, ok: boolean): string {
  const parts: string[] = [];
  if (outcomes.supervisor.status === 'stopped') parts.push(`supervisor pid ${outcomes.supervisor.pid} stopped`);
  if (outcomes.supervisor.status === 'already-stopped') parts.push('supervisor already stopped');
  if (outcomes.supervisor.status === 'timeout') parts.push(`supervisor pid ${outcomes.supervisor.pid} still running`);
  if (outcomes.supervisor.status === 'unverified') parts.push(`supervisor pid ${outcomes.supervisor.pid} unverified`);
  if (outcomes.supervisor.status === 'failed')
    parts.push(`supervisor pid ${outcomes.supervisor.pid} could not be signalled`);
  const reaped = outcomes.collectors.entries.filter((e) => e.status === 'stopped').length;
  if (reaped) parts.push(`${reaped} collector${reaped === 1 ? '' : 's'} stopped`);
  const unverified = outcomes.collectors.entries.filter((e) => e.status === 'unverified').length;
  if (unverified) parts.push(`${unverified} collector${unverified === 1 ? '' : 's'} left unsignalled`);
  if (outcomes.metro.status === 'stopped') parts.push(`metro on port ${outcomes.metro.port} stopped`);
  if (outcomes.metro.status === 'not-managed') parts.push(`external server on port ${outcomes.metro.port} left alone`);
  if (outcomes.metro.status === 'refused') parts.push(`port ${outcomes.metro.port} refused`);
  if (outcomes.metro.status === 'failed') parts.push(`port ${outcomes.metro.port} could not be freed`);
  const devicesByPlatform = Object.entries(outcomes.device).filter(([key]) => key !== 'remote');
  for (const [platform, o] of devicesByPlatform) {
    if (!o) continue;
    if (o.status === 'shut-down') parts.push(`${platform} ${o.label} shut down`);
    if (o.status === 'skipped') parts.push(`${platform} ${o.label} skipped`);
    if (o.status === 'failed') parts.push(`${platform} ${o.label} failed`);
  }
  if (outcomes.port.status === 'freed') parts.push(`port ${outcomes.port.port} freed`);
  if (outcomes.port.status === 'kept') parts.push(`port ${outcomes.port.port} kept`);
  if (outcomes.metroTunnel.status === 'stopped') parts.push(`${outcomes.metroTunnel.provider} tunnel stopped`);
  if (outcomes.metroTunnel.status === 'failed')
    parts.push(`${outcomes.metroTunnel.provider} tunnel could not be stopped`);
  for (const lease of outcomes.releasedLeases) parts.push(`${lease.platform} lease on ${lease.id} released`);
  const what = parts.length ? parts.join(', ') : 'nothing was running';
  return `${ok ? 'Stopped' : 'Stopped with problems'}: ${what} (${root})`;
}

function defaultFreePort(root: string, port: number): boolean {
  return withConfigLock(() => {
    const current = getProject(root);
    if (!current) return true;
    if (current.supervisor || current.metroPort !== port) return false;
    upsertProject(root, { metroPort: null });
    return true;
  });
}

async function defaultClearRegistration(root: string, expected?: ProcessRecord | null): Promise<boolean> {
  try {
    return clearSupervisor(root, expected);
  } catch {
    return false;
  }
}

const INTERRUPT_WAIT_MS = 60_000;

interface StopRefusal {
  code: string;
  message: string;
  remedy: string;
}

class StopBlocked extends Error {
  readonly refusal: StopRefusal;

  constructor(refusal: StopRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

class LeaveBuildRunning extends Error {}

function ownerGoneRefusal(holder: ClaimHolder, at: number): StopBlocked {
  const child = holder.child ? ` (pid ${holder.child.pid})` : '';
  return new StopBlocked({
    code: 'STIM_STOP_BLOCKED',
    message: `${describeNativeRunHolder(holder, at)} holds this workspace's native-run claim at ${holder.path}, but pid ${holder.owner.pid} is no longer that run; the build tool it started${child} still holds the claim. Stim signals only a claim owner whose identity it can prove.`,
    remedy: `Wait for the build tool${child} to exit, or end it yourself, then run \`stim stop\` again.`,
  });
}

function recordedDeviceSlots(root: string): string[] {
  const slots = new Set(projectDeviceSlots(getProject(root)).map(({ slot }) => slot));
  for (const key of Object.keys({ ...readCollectorState(root), ...fileLeaseIo.readHolder(root) })) {
    const parsed = parseDeviceSlotKey(key);
    if (parsed) slots.add(parsed.slot);
  }
  return [...slots].toSorted();
}

function workspaceDeviceSlots(root: string): string[] {
  const slots = projectDeviceSlots(getProject(root))
    .filter(({ platforms }) => Object.values(platforms).some(Boolean))
    .map(({ slot }) => slot);
  if (typeof readRemoteSession(root)?.sessionId === 'string' && !slots.includes('default')) slots.push('default');
  return slots;
}

function readRemoteSessionEntry(root: string, report: (line: string) => void): DeviceOutcomeEntry | null {
  const sessionId = readRemoteSession(root)?.sessionId;
  if (typeof sessionId !== 'string') return null;
  report(chalk.dim(phaseLine('device', `ending remote session ${sessionId} without waiting on the build lock`)));
  return endRemoteSession(root, sessionId, { teardownRemoteSession: defaultTeardownRemoteSession, report });
}

/**
 * `stop` under the workspace's native-run lock. A billable remote session is ended as soon as the lock is
 * seen held; a live `ios` or `android` run that the stop leaves nothing to deploy to is interrupted with
 * SIGINT and given INTERRUPT_WAIT_MS to exit; a build for another slot that stays is left running while
 * the slot stops without the lock; any other holder is waited on with a visible notice.
 */
export async function stopWorkspaceNow({
  root,
  slot,
  report = (line: string) => console.error(line),
  now = Date.now,
  sleep,
  waitMs = NATIVE_RUN_WAIT_MS,
  interruptWaitMs = INTERRUPT_WAIT_MS,
  inspectIdentity = inspectProcessIdentity,
  interrupt = (pid: number) => process.kill(pid, 'SIGINT'),
  endRemote = (projectRoot: string) => readRemoteSessionEntry(projectRoot, report),
  deviceSlots = workspaceDeviceSlots,
  recordedSlots = recordedDeviceSlots,
  stop = (options: { root: string; slot?: string }) => runStop(options),
}: {
  root: string;
  slot?: string;
  report?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  interruptWaitMs?: number;
  inspectIdentity?: typeof inspectProcessIdentity;
  interrupt?: (pid: number) => void;
  endRemote?: (root: string) => DeviceOutcomeEntry | null;
  deviceSlots?: (root: string) => string[];
  recordedSlots?: (root: string) => string[];
  stop?: (options: { root: string; slot?: string }) => ReturnType<typeof runStop>;
}): Promise<Awaited<ReturnType<typeof runStop>> | { refusal: StopRefusal; remote: DeviceOutcomeEntry | null }> {
  if (slot === WEB_SLOT) return stop({ root, slot });
  const known = slot === undefined ? [] : recordedSlots(root);
  let unknownSlot = slot !== undefined && !known.includes(slot);
  const unknownSlotRefusal = () =>
    new StopBlocked({
      code: 'STIM_BAD_ARG',
      message: `This workspace has no device slot named ${slot}. Its slots are ${known.join(', ')}.`,
      remedy: `Run \`stim stop --slot <name>\` with one of those slots, \`stim stop --slot ${WEB_SLOT}\` to close only the owned Chrome, or \`stim stop\` for the whole workspace.`,
    });
  let remote: DeviceOutcomeEntry | null = null;
  let remoteHandled = slot !== undefined;
  const endRemoteNow = () => {
    if (remoteHandled) return;
    remoteHandled = true;
    remote = endRemote(root);
  };
  const notice = nativeRunWaitNotice({ write: (line) => report(chalk.dim(phaseLine('lock', line))), now });
  let seen: { claimId: string; action: StopHolderAction['action']; deadline: number } | null = null;
  const interrupted: string[] = [];

  const onHeld = (holder: ClaimHolder): void => {
    const at = now();
    if (seen?.claimId === holder.claimId) {
      if (seen.action === 'interrupt' && at >= seen.deadline) {
        if (inspectIdentity(holder.owner) !== 'same') throw ownerGoneRefusal(holder, at);
        throw new StopBlocked({
          code: 'STIM_STOP_BLOCKED',
          message: `${describeNativeRunHolder(holder, at)} did not exit within ${Math.round(interruptWaitMs / 1000)}s of SIGINT; it still holds this workspace's native-run claim at ${holder.path}.`,
          remedy: `Wait for it to finish, or end it with \`kill ${holder.owner.pid}\`, then run \`stim stop\` again.`,
        });
      }
      notice(holder);
      return;
    }
    endRemoteNow();
    const target = nativeRunHolder(holder);
    if (unknownSlot) {
      if (target.slot !== slot) throw unknownSlotRefusal();
      unknownSlot = false;
    }
    const { action } = decideStopAction({
      stopSlot: slot,
      holder: target,
      ownerIdentity: inspectIdentity(holder.owner),
      deviceSlots: deviceSlots(root),
    });
    seen = { claimId: holder.claimId, action, deadline: Number.POSITIVE_INFINITY };
    const who = describeNativeRunHolder(holder, at);
    if (action === 'proceed') {
      notice(holder, `leaving ${who} running: slot ${target.slot} stays, so slot ${slot} stops without the build lock`);
      throw new LeaveBuildRunning();
    }
    if (action === 'refuse') throw ownerGoneRefusal(holder, at);
    if (action === 'interrupt') {
      requestNativeRunCancel(root, holder.claimId);
      interrupted.push(holder.claimId);
      seen = { claimId: holder.claimId, action, deadline: now() + interruptWaitMs };
      if (inspectIdentity(holder.owner) !== 'same') return;
      try {
        interrupt(holder.owner.pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
      }
      notice(
        holder,
        `interrupting ${who}: sent SIGINT, waiting up to ${Math.round(interruptWaitMs / 1000)}s for it to exit`,
      );
      return;
    }
    notice(holder);
  };

  const withRemote = (result: Awaited<ReturnType<typeof runStop>>): Awaited<ReturnType<typeof runStop>> => {
    if (!remote || result.outcomes.device.remote) return result;
    result.outcomes.device.remote = remote;
    if (!remoteEnded(remote)) result.ok = false;
    return result;
  };

  try {
    return withRemote(
      await withWorkspaceProcessLock(
        workspaceDir(root),
        NATIVE_RUN_LOCK,
        () => {
          if (unknownSlot && !recordedSlots(root).includes(slot!)) throw unknownSlotRefusal();
          return stop({ root, slot });
        },
        {
          external: true,
          waitMs,
          now,
          ...(sleep ? { sleep } : {}),
          details: { command: 'stop', ...(slot === undefined ? {} : { slot }) },
          onHeld,
        },
      ),
    );
  } catch (error) {
    if (error instanceof LeaveBuildRunning) return withRemote(await stop({ root, slot }));
    if (error instanceof StopBlocked) return { refusal: error.refusal, remote };
    if (isClaimRefusal(error)) endRemoteNow();
    throw error;
  } finally {
    for (const claimId of interrupted) clearNativeRunCancel(root, claimId);
  }
}

interface StopOptions {
  slot?: string;
  json?: boolean;
}

export default function stopCommand(program: Command): void {
  program
    .command('stop')
    .description(
      "The inverse of `start`: halt this workspace's supervisor, shut the owned device down (never deleted), and free the reserved port. Non-destructive -- the device stays assigned, so coming back costs a boot. Acts on the current workspace.",
    )
    .option(
      '--slot <name>',
      "Stop only this device slot, keeping the shared server running. Use 'default' for the workspace's default device, or 'web' to close only the owned Chrome.",
      (slot: string) => (slot === WEB_SLOT ? slot : parseDeviceSlotOption(slot)),
    )
    .option('--json', 'print the per-step outcomes as JSON')
    .action(async (opts: StopOptions) => {
      const root = findCommandWorkspace(process.cwd());
      if (!root) {
        refuseNoProject({ json: Boolean(opts.json) });
        return;
      }

      const stopped = await stopWorkspaceNow({ root, slot: opts.slot });
      if ('refusal' in stopped) {
        const { code, message, remedy } = stopped.refusal;
        console.error(chalk.red(phaseLine('error', `${code}: ${message}`)));
        console.error(phaseLine('remedy', remedy));
        if (opts.json) {
          const remote = stopped.remote ? { device: { remote: stopped.remote } } : {};
          console.log(JSON.stringify({ root, ok: false, code, message, remedy, ...remote }));
        }
        process.exit(1);
      }
      const { ok, outcomes, summary } = stopped;

      if (opts.json) {
        console.log(JSON.stringify({ root, ok, ...outcomes }));
      } else {
        console.log(ok ? chalk.green(summary) : chalk.yellow(summary));
      }
      if (!ok) process.exit(1);
    });
}
