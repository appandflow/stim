import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rotatedLogPath, type StimContext } from '@stim-cli/core';
import {
  coerceSettingText,
  deviceViewersDir,
  readJsonObject,
  parseNdjsonText,
  settingDefinition,
  settingValueError,
  type DeviceActivity,
  type MaintenanceAction,
} from '@stim-cli/core/state';
import { formatLongDuration } from '../command-output.ts';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { runStop } from '../commands/stop.ts';
import {
  getAvdNameForSerial,
  getAvdNameForSerialAsync,
  listAdbDevices,
  listAdbDevicesAsync,
  ownedAvdSerialResolver,
  ownedAvdSerialResolverAsync,
} from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { leaseIsExpired, listLeaseFiles } from '../engine/device-lease.ts';
import {
  WorkspaceProcessCleanupError,
  withWorkspaceProcessLock,
  workspaceProcessLockError,
} from '../engine/workspace-process-lock.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { MODE_COMMAND, readRemoteSession } from '../supervisor/state.ts';
import { loadConfig } from '../workspace/config.ts';
import { withIdleWorkspace, workspaceInUse, workspaceInUseAsync } from '../workspace/in-use.ts';
import { workspaceAgentDeviceDir, workspaceDir, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { resolveProjectSettings, resolveProjectSettingsAsync, settingValueAt } from '../workspace/settings.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { readWebRecord, webFacts } from '../web/state.ts';
import type { MaintenancePlan } from './plan.ts';

const HOUR_MS = 3_600_000;
const SETTING = 'maintenance.idleStopHours';
const METRO_REQUESTS = new Set([
  'bundle_response_started',
  'bundle_build_started',
  'manifest_request_started',
  'hmr_update',
]);
const STIM_SESSION = 'stim-teardown-inventory';
const AGENT_DEVICE_DRIVERS = new Set(['agent-device-claim', 'agent-device-lease']);

type IdleStopBasis = 'stim command' | 'native run' | 'Metro request' | 'agent-device command' | 'live view';

interface IdleStopEvidence {
  activity: { basis: IdleStopBasis; at: number }[];
  keep: string[];
}

type IdleStopDecision = { stop: true; idleMs: number } | { stop: false; reason: string; active?: true };

function decideIdleStop(
  evidence: IdleStopEvidence,
  { idleMs, now }: { idleMs: number; now: number },
): IdleStopDecision {
  if (!(idleMs > 0)) return { stop: false, reason: `${SETTING} is 0` };
  const last = evidence.activity
    .filter(({ at }) => Number.isFinite(at))
    .reduce<IdleStopEvidence['activity'][number] | null>(
      (best, entry) => (!best || entry.at > best.at ? entry : best),
      null,
    );
  const idle = last ? now - last.at : NaN;
  if (last && idle < idleMs)
    return {
      stop: false,
      active: true,
      reason: `its last ${last.basis} was ${formatLongDuration(Math.max(0, idle))} ago, within ${SETTING}`,
    };
  if (evidence.keep.length) return { stop: false, reason: evidence.keep.join('; ') };
  if (!last) return { stop: false, reason: 'its last activity is unknown' };
  return { stop: true, idleMs: idle };
}

async function idleStopHours(
  root: string,
  env: NodeJS.ProcessEnv,
  operation?: StimContext,
): Promise<{ hours: number } | { invalid: string }> {
  const setting = settingDefinition(SETTING);
  if (!setting?.env) return { invalid: `${SETTING} is not in the settings registry` };
  const raw = env[setting.env];
  const fromEnv = raw !== undefined && raw !== '';
  let value: unknown;
  if (fromEnv) value = coerceSettingText(setting, raw);
  else {
    try {
      const resolved = operation
        ? await resolveProjectSettingsAsync(root, { env, signal: operation.signal, declareFor: operation })
        : resolveProjectSettings(root);
      value = settingValueAt(resolved.settings, SETTING);
    } catch (error) {
      rethrowCleanup(error, operation?.signal);
      return { invalid: `${SETTING} cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (value === undefined) return { hours: Number(setting.default) };
  const error = settingValueError(setting, value);
  return error || typeof value !== 'number'
    ? { invalid: `${fromEnv ? setting.env : SETTING} is invalid: expected ${error ?? 'a number'}` }
    : { hours: value };
}

function deviceKeepReason(device: OwnedDeviceActivity, platform: NodeJS.Platform): string | null {
  const { activity } = device;
  const what = `its ${device.kind === 'ios' ? 'simulator' : 'emulator'} ${device.name}`;
  if (activity.state === 'driven' && !activity.basis.every((basis) => AGENT_DEVICE_DRIVERS.has(basis)))
    return `${what} is driven by ${activity.driver?.tool ?? 'an unknown tool'}`;
  if (activity.basis.includes('agent-device-claim') && !activity.recent?.['agent-action'])
    return `${what} has a live agent-device claim whose session activity cannot be found`;
  // The host driver probe runs `ps -axww`, which Windows lacks. Stim drives only Android there, and Android
  // drivers run on-device instrumentation the adb probe reads.
  const probed =
    activity.state === 'driven' ? (activity.unknown ?? []) : activity.state === 'unknown' ? activity.basis : [];
  const unknown = platform === 'win32' ? probed.filter((basis) => basis !== 'driver-process') : probed;
  if (unknown.length) return `${what} has unknown activity (${unknown.join(', ')})`;
  return null;
}

function recentAt(activity: DeviceActivity, basis: 'agent-action' | 'viewer'): number {
  return Date.parse(activity.recent?.[basis] ?? '');
}

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function agentSessionsActedAt(root: string): number | string {
  const dir = join(workspaceAgentDeviceDir(root), 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return missing(error) ? NaN : `its agent-device sessions cannot be read (${message(error)})`;
  }
  let latest = NaN;
  for (const name of names) {
    if (name === STIM_SESSION) continue;
    try {
      const at = statSync(join(dir, name, 'events.ndjson')).mtimeMs;
      if (!(at <= latest)) latest = at;
    } catch (error) {
      if (!missing(error)) return `its agent-device session ${name} cannot be read (${message(error)})`;
    }
  }
  return latest;
}

function metroRequestAt(root: string, since: number, serving: boolean): number | string {
  const file = join(workspaceLogsDir(root), 'metro.ndjson');
  const rotated = rotatedLogPath(file);
  const records = [];
  for (const path of [rotated, file]) {
    try {
      records.push(...parseNdjsonText(readFileSync(path, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      return `its Metro log cannot be read (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  let latest = NaN;
  let earliest = Infinity;
  for (const record of records) {
    if (typeof record.ts !== 'number') continue;
    earliest = Math.min(earliest, record.ts);
    if (typeof record.event === 'string' && METRO_REQUESTS.has(record.event) && !(record.ts <= latest))
      latest = record.ts;
  }
  if (!Number.isFinite(latest) && earliest > since && existsSync(rotated))
    return `its rotated Metro log does not reach back ${SETTING}`;
  if (serving && earliest === Infinity) return 'its dev server runs but its Metro log is missing or empty';
  return latest;
}

function unreadableViewers(): string | null {
  const dir = deviceViewersDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    return missing(error) ? null : `the stim-server viewer records cannot be read (${message(error)})`;
  }
  for (const name of names) {
    const record = readJsonObject(join(dir, name));
    if (!record) return `the stim-server viewer record ${name} cannot be read`;
    if (inspectProcessIdentity(record) === 'unknown')
      return `the stim-server behind the viewer record ${name} cannot be verified`;
  }
  return null;
}

async function keepReasons(
  root: string,
  devices: readonly OwnedDeviceActivity[],
  {
    now,
    platform,
    locked,
    operation,
  }: { now: number; platform: NodeJS.Platform; locked: boolean; operation?: StimContext },
) {
  const checks = { devServer: false, nativeRun: !locked };
  const keep = operation
    ? await workspaceInUseAsync(root, checks, operation.signal, operation)
    : workspaceInUse(root, checks);
  if (workspaceBuildInProgress(root)) keep.push('a build is in progress');
  if (readRemoteSession(root)) keep.push('it has a remote device session');
  const holder = canonicalPath(root);
  for (const { lease, path } of listLeaseFiles()) {
    if (!lease) keep.push(`the device lease ${path} cannot be read`);
    else if (!leaseIsExpired(lease, now) && canonicalPath(lease.holder) === holder)
      keep.push(`it holds the ${lease.platform} device lease on ${lease.deviceName ?? lease.id}`);
  }
  const browser = webFacts(readWebRecord(root));
  if (browser && browser.status !== 'stopped') keep.push(`its owned Chrome is ${browser.status}`);
  for (const device of devices) {
    const reason = deviceKeepReason(device, platform);
    if (reason) keep.push(reason);
  }
  const viewers = devices.length ? unreadableViewers() : null;
  if (viewers) keep.push(viewers);
  return keep;
}

async function idleStopEvidence(
  root: string,
  devices: readonly OwnedDeviceActivity[],
  {
    now,
    idleMs,
    platform = process.platform,
    locked = false,
    serving = false,
    operation,
  }: {
    now: number;
    idleMs: number;
    platform?: NodeJS.Platform;
    locked?: boolean;
    serving?: boolean;
    operation?: StimContext;
  },
): Promise<IdleStopEvidence> {
  const state = readWorkspaceState(root);
  if (!state && existsSync(workspaceStateFile(root))) return { activity: [], keep: ['its state.json cannot be read'] };
  const sessions = agentSessionsActedAt(root);
  if (typeof sessions === 'string') return { activity: [], keep: [sessions] };
  const build = state?.lastBuild;
  const builtAt =
    Date.parse(String(build?.startedAt ?? '')) + (typeof build?.durationMs === 'number' ? build.durationMs : 0);
  const activity: IdleStopEvidence['activity'] = [
    { basis: 'stim command' as const, at: Date.parse(String(state?.lastUsedAt ?? '')) },
    { basis: 'native run' as const, at: builtAt },
    { basis: 'agent-device command' as const, at: typeof sessions === 'number' ? sessions : NaN },
    ...devices.flatMap(({ activity: device }) => [
      { basis: 'agent-device command' as const, at: recentAt(device, 'agent-action') },
      { basis: 'live view' as const, at: recentAt(device, 'viewer') },
    ]),
  ].filter(({ at }) => Number.isFinite(at));
  if (activity.some(({ at }) => now - at < idleMs)) return { activity, keep: [] };
  const keep = await keepReasons(root, devices, { now, platform, locked, operation });
  if (keep.length) return { activity, keep };
  const metro = metroRequestAt(root, now - idleMs, serving);
  if (typeof metro === 'string') return { activity, keep: [metro] };
  if (Number.isFinite(metro)) activity.push({ basis: 'Metro request', at: metro });
  return { activity, keep };
}

interface IdleStopCandidate {
  path: string;
  hours: number;
  serving: boolean;
  devices: OwnedDeviceActivity[];
}

type DeviceReader = (withSims: boolean) => OwnedDeviceActivity[] | Promise<OwnedDeviceActivity[]>;

function rethrowCleanup(error: unknown, signal: AbortSignal | undefined): void {
  if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
    throw error;
  signal?.throwIfAborted();
}

async function emulatorListError(avdNames: readonly string[], operation?: StimContext): Promise<string | null> {
  try {
    const signal = operation?.signal;
    const resolve = operation
      ? ownedAvdSerialResolverAsync({ timeoutMs: 5000, signal, operation })
      : ownedAvdSerialResolver({ timeoutMs: 5000 });
    let unseen = false;
    for (const name of avdNames) if ((await resolve(name)).notRunning) unseen = true;
    if (!unseen) return null;
    const { emulators } = operation
      ? await listAdbDevicesAsync({ timeoutMs: 5000, signal, operation })
      : listAdbDevices({ timeoutMs: 5000 });
    for (const { serial } of emulators) {
      const name = operation
        ? await getAvdNameForSerialAsync(serial, { timeoutMs: 5000, signal, operation })
        : getAvdNameForSerial(serial, { timeoutMs: 5000 });
      if (name === null) return `its emulators cannot be identified to prove them idle (${serial} gave no AVD name)`;
    }
    return null;
  } catch (error) {
    rethrowCleanup(error, operation?.signal);
    return `its emulators cannot be listed to prove them idle (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function candidate(
  path: string,
  env: NodeJS.ProcessEnv,
  devices: DeviceReader,
  operation?: StimContext,
): Promise<IdleStopCandidate | { skip: string } | null> {
  const signal = operation?.signal;
  const project = loadConfig()?.projects?.[path];
  if (!project) return null;
  const supervisor = resolveSupervisorTarget({
    state: readWorkspaceState(path)?.supervisor,
    record: project.supervisor,
    reservedPort: project.metroPort,
  });
  const slots = projectDeviceSlots(project);
  const ownsIos = slots.some(({ platforms }) => platforms.ios?.owned === true);
  const owns = ownsIos || slots.some(({ platforms }) => platforms.android?.owned === true);
  if (!owns && (supervisor.status === 'none' || supervisor.status === 'stale')) return null;
  const setting = await idleStopHours(path, env, operation);
  if ('invalid' in setting) return { skip: setting.invalid };
  if (setting.hours === 0) return null;
  let booted: OwnedDeviceActivity[] = [];
  if (owns) {
    try {
      booted = (await devices(ownsIos)).filter((device) => device.project === path);
    } catch (error) {
      rethrowCleanup(error, signal);
      return supervisor.status === 'none' || supervisor.status === 'stale'
        ? null
        : { skip: 'its owned devices cannot be listed to prove them idle' };
    }
  }
  if (supervisor.status === 'unverified')
    return { skip: `its dev server supervisor cannot be verified: ${supervisor.reason ?? 'unknown identity'}` };
  if (supervisor.status === 'ours' && readWorkspaceState(path)?.supervisor?.mode === MODE_COMMAND)
    return { skip: 'its dev server runs metro.command, whose bundle and HMR requests Stim cannot see' };
  if (supervisor.status === 'ours' && readWorkspaceState(path)?.supervisor?.hmrUpdates !== true)
    return {
      skip: 'its dev server started before Stim recorded HMR updates; stim stop, then stim start, to enable idle stop',
    };
  const avdNames = slots.flatMap(({ platforms }) =>
    platforms.android?.owned && platforms.android.avdName ? [platforms.android.avdName] : [],
  );
  const emulators =
    supervisor.status === 'ours' && avdNames.length ? await emulatorListError(avdNames, operation) : null;
  if (emulators) return { skip: emulators };
  if (supervisor.status !== 'ours' && booted.length === 0) return null;
  return { path, hours: setting.hours, serving: supervisor.status === 'ours', devices: booted };
}

/**
 * Plans stopping each workspace, other than `protectedRoot`, whose dev server runs or whose owned simulator or
 * emulator is booted, once it has had no real activity for its maintenance.idleStopHours.
 */
export async function planIdleStop({
  protectedRoot,
  now,
  devices,
  env = process.env,
  platform = process.platform,
  operation,
}: {
  protectedRoot: string;
  now: number;
  devices: DeviceReader;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  operation?: StimContext;
}): Promise<MaintenancePlan> {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  if (deviceSweepIsScoped(env)) return plan;
  for (const path of Object.keys(loadConfig()?.projects ?? {})) {
    const root = canonicalPath(path);
    if (root === protectedRoot) continue;
    operation?.signal.throwIfAborted();
    const found = await candidate(path, env, devices, operation);
    if (!found) continue;
    if ('skip' in found) {
      plan.skips.push({ target: root, reason: found.skip, workspace: root });
      continue;
    }
    const idleMs = found.hours * HOUR_MS;
    const evidence = await idleStopEvidence(path, found.devices, {
      now,
      idleMs,
      platform,
      serving: found.serving,
      operation,
    });
    const decision = decideIdleStop(evidence, { idleMs, now });
    if (!decision.stop) {
      if (!decision.active) plan.skips.push({ target: root, reason: decision.reason, workspace: root });
      continue;
    }
    plan.actions.push({
      kind: 'would-stop-workspace',
      check: 'idle',
      target: root,
      workspace: root,
      bytes: 0,
      reason: `no real activity for ${formatLongDuration(decision.idleMs)}, over ${SETTING} ${found.hours}`,
    });
  }
  return plan;
}

export interface IdleStopOutcome {
  status: 'done' | 'kept' | 'failed';
  bytes: number;
  detail: string;
}

const kept = (detail: string): IdleStopOutcome => ({ status: 'kept', bytes: 0, detail });

/**
 * Stops a planned idle workspace the way `stim stop` does, under its native-run and metro-start locks, after
 * deciding again that it is still idle. Physical-device leases stay.
 */
export async function stopIdleWorkspace(
  action: Pick<MaintenanceAction, 'target' | 'workspace' | 'reason'>,
  {
    protectedRoot,
    devices,
    operation,
    env = operation?.env ?? process.env,
    by = 'automatic maintenance',
  }: {
    protectedRoot: string;
    devices: () => DeviceReader;
    operation?: StimContext;
    env?: NodeJS.ProcessEnv;
    by?: string;
  },
): Promise<IdleStopOutcome> {
  const root = action.workspace ?? action.target;
  if (root === protectedRoot) return kept('the command that started this pass runs in it');
  if (deviceSweepIsScoped(env)) return kept('STIM_HOME scopes this config, and devices are machine-wide');
  const path = Object.keys(loadConfig()?.projects ?? {}).find((entry) => canonicalPath(entry) === root) ?? root;
  const stillIdle = async (): Promise<string | null> => {
    const now = Date.now();
    const found = await candidate(path, env, devices(), operation);
    if (!found) return 'nothing of it runs any more';
    if ('skip' in found) return found.skip;
    const idleMs = found.hours * HOUR_MS;
    const evidence = await idleStopEvidence(path, found.devices, {
      now,
      idleMs,
      locked: true,
      serving: found.serving,
      operation,
    });
    const decision = decideIdleStop(evidence, { idleMs, now });
    return decision.stop ? null : decision.reason;
  };
  const signal = operation?.signal;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<IdleStopOutcome> => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async () => {
            const active = await stillIdle();
            if (active) return kept(active);
            const stopped = await runStop({
              root: path,
              operation,
              report: () => {},
              requester: { by: `${by} (${action.reason})` },
              releaseLeases: () => [],
            });
            return stopped.ok
              ? { status: 'done', bytes: 0, detail: stopped.summary }
              : { status: 'failed', bytes: 0, detail: stopped.summary };
          },
          { external: true, waitMs: 0, ownerPurpose: 'idle stop', signal, declareSpawnsFor: operation },
        );
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        signal?.throwIfAborted();
        if (workspaceProcessLockError(error)) return kept('a stim start holds its metro-start lock');
        throw error;
      }
    },
    { purpose: 'automatic maintenance', devServer: false, operation },
  );
  return run.ran ? run.value : kept(`in use: ${run.reasons.join('; ')}`);
}
