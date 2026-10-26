import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import {
  coerceSettingText,
  readNdjsonGenerations,
  settingDefinition,
  settingValueError,
  type DeviceActivity,
  type MaintenanceAction,
} from '@stim-cli/core/state';
import { formatLongDuration } from '../command-output.ts';
import { workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { runStop } from '../commands/stop.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { leaseIsExpired, listLeaseFiles } from '../engine/device-lease.ts';
import {
  WorkspaceProcessCleanupError,
  withWorkspaceProcessLock,
  workspaceProcessLockError,
} from '../engine/workspace-process-lock.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { readRemoteSession } from '../supervisor/state.ts';
import { loadConfig } from '../workspace/config.ts';
import { withIdleWorkspace, workspaceInUse } from '../workspace/in-use.ts';
import { workspaceAgentDeviceDir, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { resolveProjectSettings, settingValueAt } from '../workspace/settings.ts';
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

type IdleStopDecision = { stop: true; idleMs: number } | { stop: false; reason: string };

function decideIdleStop(
  evidence: IdleStopEvidence,
  { idleMs, now }: { idleMs: number; now: number },
): IdleStopDecision {
  if (!(idleMs > 0)) return { stop: false, reason: `${SETTING} is 0` };
  if (evidence.keep.length) return { stop: false, reason: evidence.keep.join('; ') };
  const last = evidence.activity
    .filter(({ at }) => Number.isFinite(at))
    .reduce<IdleStopEvidence['activity'][number] | null>(
      (best, entry) => (!best || entry.at > best.at ? entry : best),
      null,
    );
  if (!last) return { stop: false, reason: 'its last activity is unknown' };
  const idle = now - last.at;
  if (idle < idleMs)
    return {
      stop: false,
      reason: `its last ${last.basis} was ${formatLongDuration(Math.max(0, idle))} ago, within ${SETTING}`,
    };
  return { stop: true, idleMs: idle };
}

function idleStopHours(root: string, env: NodeJS.ProcessEnv = process.env): { hours: number } | { invalid: string } {
  const setting = settingDefinition(SETTING);
  if (!setting?.env) return { invalid: `${SETTING} is not in the settings registry` };
  const raw = env[setting.env];
  const fromEnv = raw !== undefined && raw !== '';
  let value: unknown;
  if (fromEnv) value = coerceSettingText(setting, raw);
  else {
    try {
      value = settingValueAt(resolveProjectSettings(root).settings, SETTING);
    } catch (error) {
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
  // The host driver probe runs `ps -axww`, which Windows lacks. Stim drives only Android there, and Android
  // drivers run on-device instrumentation the adb probe reads.
  const unknown = platform === 'win32' ? activity.basis.filter((basis) => basis !== 'driver-process') : activity.basis;
  if (activity.state === 'unknown' && unknown.length) return `${what} has unknown activity (${unknown.join(', ')})`;
  return null;
}

function recentAt(activity: DeviceActivity, basis: 'agent-action' | 'viewer'): number {
  return Date.parse(activity.recent?.[basis] ?? '');
}

function agentSessionsActedAt(root: string): number {
  const dir = join(workspaceAgentDeviceDir(root), 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return NaN;
  }
  let latest = NaN;
  for (const name of names) {
    if (name === STIM_SESSION) continue;
    try {
      const at = statSync(join(dir, name, 'events.ndjson')).mtimeMs;
      if (!(at <= latest)) latest = at;
    } catch {}
  }
  return latest;
}

function metroRequestAt(root: string): number | string {
  const file = join(workspaceLogsDir(root), 'metro.ndjson');
  try {
    statSync(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return NaN;
    return `its Metro log cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
  let latest = NaN;
  for (const record of readNdjsonGenerations(file))
    if (typeof record.event === 'string' && METRO_REQUESTS.has(record.event) && typeof record.ts === 'number')
      if (!(record.ts <= latest)) latest = record.ts;
  return latest;
}

function keepReasons(
  root: string,
  devices: readonly OwnedDeviceActivity[],
  { now, platform, locked }: { now: number; platform: NodeJS.Platform; locked: boolean },
) {
  const keep = workspaceInUse(root, { devServer: false, nativeRun: !locked });
  if (workspaceBuildInProgress(root)) keep.push('a build is in progress');
  if (readRemoteSession(root)) keep.push('it has a remote device session');
  const holder = canonicalPath(root);
  for (const { lease } of listLeaseFiles())
    if (lease && !leaseIsExpired(lease, now) && canonicalPath(lease.holder) === holder)
      keep.push(`it holds the ${lease.platform} device lease on ${lease.deviceName ?? lease.id}`);
  const browser = webFacts(readWebRecord(root));
  if (browser && browser.status !== 'stopped') keep.push(`its owned Chrome is ${browser.status}`);
  for (const device of devices) {
    const reason = deviceKeepReason(device, platform);
    if (reason) keep.push(reason);
  }
  return keep;
}

function idleStopEvidence(
  root: string,
  devices: readonly OwnedDeviceActivity[],
  {
    now,
    idleMs,
    platform = process.platform,
    locked = false,
  }: { now: number; idleMs: number; platform?: NodeJS.Platform; locked?: boolean },
): IdleStopEvidence {
  const keep = keepReasons(root, devices, { now, platform, locked });
  if (keep.length) return { activity: [], keep };
  const state = readWorkspaceState(root);
  const build = state?.lastBuild;
  const builtAt =
    Date.parse(String(build?.startedAt ?? '')) + (typeof build?.durationMs === 'number' ? build.durationMs : 0);
  const activity: IdleStopEvidence['activity'] = [
    { basis: 'stim command' as const, at: Date.parse(String(state?.lastUsedAt ?? '')) },
    { basis: 'native run' as const, at: builtAt },
    { basis: 'agent-device command' as const, at: agentSessionsActedAt(root) },
    ...devices.flatMap(({ activity: device }) => [
      { basis: 'agent-device command' as const, at: recentAt(device, 'agent-action') },
      { basis: 'live view' as const, at: recentAt(device, 'viewer') },
    ]),
  ].filter(({ at }) => Number.isFinite(at));
  if (activity.some(({ at }) => now - at < idleMs)) return { activity, keep };
  const metro = metroRequestAt(root);
  if (typeof metro === 'string') return { activity, keep: [metro] };
  if (Number.isFinite(metro)) activity.push({ basis: 'Metro request', at: metro });
  return { activity, keep };
}

interface IdleStopCandidate {
  path: string;
  hours: number;
  devices: OwnedDeviceActivity[];
}

type DeviceReader = (withSims: boolean) => OwnedDeviceActivity[] | Promise<OwnedDeviceActivity[]>;

async function candidate(
  path: string,
  env: NodeJS.ProcessEnv,
  devices: DeviceReader,
): Promise<IdleStopCandidate | { skip: string } | null> {
  const project = loadConfig()?.projects?.[path];
  if (!project) return null;
  const setting = idleStopHours(path, env);
  if ('invalid' in setting) return { skip: setting.invalid };
  if (setting.hours === 0) return null;
  const supervisor = resolveSupervisorTarget({
    state: readWorkspaceState(path)?.supervisor,
    record: project.supervisor,
    reservedPort: project.metroPort,
  });
  const slots = projectDeviceSlots(project);
  const ownsIos = slots.some(({ platforms }) => platforms.ios?.owned === true);
  const owns = ownsIos || slots.some(({ platforms }) => platforms.android?.owned === true);
  let booted: OwnedDeviceActivity[] = [];
  if (owns) {
    try {
      booted = (await devices(ownsIos)).filter((device) => device.project === path);
    } catch {
      return supervisor.status === 'none' || supervisor.status === 'stale'
        ? null
        : { skip: 'its owned devices cannot be listed to prove them idle' };
    }
  }
  if (supervisor.status === 'unverified')
    return { skip: `its dev server supervisor cannot be verified: ${supervisor.reason ?? 'unknown identity'}` };
  if (supervisor.status !== 'ours' && booted.length === 0) return null;
  return { path, hours: setting.hours, devices: booted };
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
}: {
  protectedRoot: string;
  now: number;
  devices: DeviceReader;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<MaintenancePlan> {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  for (const path of Object.keys(loadConfig()?.projects ?? {})) {
    const root = canonicalPath(path);
    if (root === protectedRoot) continue;
    const found = await candidate(path, env, devices);
    if (!found) continue;
    if ('skip' in found) {
      plan.skips.push({ target: root, reason: found.skip, workspace: root });
      continue;
    }
    const idleMs = found.hours * HOUR_MS;
    const decision = decideIdleStop(idleStopEvidence(path, found.devices, { now, idleMs, platform }), { idleMs, now });
    if (!decision.stop) {
      plan.skips.push({ target: root, reason: decision.reason, workspace: root });
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
  }: { protectedRoot: string; devices: () => DeviceReader; operation?: StimContext; env?: NodeJS.ProcessEnv },
): Promise<IdleStopOutcome> {
  const root = action.workspace ?? action.target;
  if (root === protectedRoot) return kept('the command that started this pass runs in it');
  const path = Object.keys(loadConfig()?.projects ?? {}).find((entry) => canonicalPath(entry) === root) ?? root;
  const stillIdle = async (locked: boolean): Promise<string | null> => {
    const now = Date.now();
    const found = await candidate(path, env, devices());
    if (!found) return 'nothing of it runs any more';
    if ('skip' in found) return found.skip;
    const idleMs = found.hours * HOUR_MS;
    const decision = decideIdleStop(idleStopEvidence(path, found.devices, { now, idleMs, locked }), { idleMs, now });
    return decision.stop ? null : decision.reason;
  };
  const first = await stillIdle(false);
  if (first) return kept(first);
  const signal = operation?.signal;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<IdleStopOutcome> => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async () => {
            const active = await stillIdle(true);
            if (active) return kept(active);
            const lines: string[] = [];
            const stopped = await runStop({
              root: path,
              operation,
              report: (line) => lines.push(line),
              requester: { by: `automatic maintenance (${action.reason})` },
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
