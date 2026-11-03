import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorkspaces, HarnessError } from './workspaces.mjs';
import { configureClocks } from './clocks.mjs';
import { newestRecordMs } from './collect.mjs';
import { ladderActions } from './ladder.mjs';
import { clock, judgeIdleTiming, outcome, STATUS } from './assertions.mjs';
import { bootsInFlight, daemonLine, findEnvironment, idleFacts, waitingRuns } from './evidence.mjs';
import { parseCsv, parseLoad1 } from './platform.mjs';
import { run, sleep } from './shell.mjs';

export const TICK_MS = 60_000;
// The daemon ticks every 5 minutes while nothing runs in the home and pressure is normal (section 1 of docs/specs/2026-11-02-resource-model-design.md as amended 2026-11-02, in the pressure ladder pull request, #4835), and every minute otherwise.
export const QUIET_TICK_MS = 5 * 60_000;
export const POLL_MS = 15_000;
const DEFAULT_IDLE_WINDOW_MS = 15 * 60_000;

export async function setup(ctx, count) {
  await createWorkspaces(ctx, count);
  ctx.clocks = await configureClocks(ctx.stim, ctx.workspaces, {
    idleMinutes: ctx.opts.idleMinutes,
    dormantMinutes: ctx.opts.dormantMinutes,
  });
  for (const note of ctx.clocks.notes) ctx.emit('setup', note);
  ctx.idleWindowMs = ctx.clocks.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
}

async function currentLoad() {
  const result = await run('sysctl', ['-n', 'vm.loadavg'], { timeoutMs: 10_000 });
  return parseLoad1(result.stdout);
}

export async function loadGate(ctx, what) {
  const waitUntil = Date.now() + 20 * 60_000;
  let announced = 0;
  for (;;) {
    const load = await currentLoad();
    if (load === null || load < ctx.opts.maxLoad) return load;
    if (Date.now() > waitUntil)
      throw new HarnessError(
        `1-minute load stayed at ${load} (limit ${ctx.opts.maxLoad}) for 20 minutes before ${what}`,
      );
    if (Date.now() - announced > 60_000) {
      ctx.emit('gate', `load ${load} is at or over ${ctx.opts.maxLoad}; waiting before ${what}`);
      announced = Date.now();
    }
    await sleep(10_000, ctx.signal);
    if (ctx.signal.aborted) throw new HarnessError('aborted');
  }
}

export async function pollStatus(ctx) {
  const snapshot = await ctx.stim.status();
  await ctx.trackLedger();
  const { payload } = snapshot;
  const digest = {
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    ok: payload !== null,
    bootsInFlight: bootsInFlight(payload),
    waitingRuns: waitingRuns(payload),
    deviceSlots: payload?.capacity?.devices
      ? { max: payload.capacity.devices.max, inUse: payload.capacity.devices.inUse }
      : null,
    daemon: daemonLine(payload),
    pressureLevel: payload?.daemon?.pressure?.level ?? null,
    envs: {},
  };
  for (const workspace of ctx.workspaces) {
    const env = findEnvironment(payload, workspace.path);
    digest.envs[workspace.path] = {
      facts: idleFacts(env),
      build: env?.build ? { state: env.build.state, phase: env.build.phase, platform: env.build.platform } : null,
      workspaceId: env?.workspaceId ?? null,
    };
  }
  ctx.snapshots.push(digest);
  return digest;
}

export function startPoller(ctx) {
  const state = { stopped: false };
  const done = (async () => {
    while (!state.stopped && !ctx.signal.aborted) {
      const began = Date.now();
      try {
        await pollStatus(ctx);
      } catch (error) {
        ctx.emit('error', `status poll failed: ${error?.message ?? error}`);
      }
      const took = Date.now() - began;
      await sleep(Math.max(1000, POLL_MS - took, took), ctx.signal);
    }
  })();
  return {
    async stop() {
      state.stopped = true;
      await done;
    },
  };
}

export function hasEntries(dir) {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export async function launch(ctx, workspace, { timeoutMs = 60 * 60_000 } = {}) {
  ctx.setStage(`launch-${workspace.label}`);
  const started = await ctx.stim.exec(`start-${workspace.label}`, workspace.path, ['start', '--json'], {
    timeoutMs: 5 * 60_000,
  });
  const ios = await ctx.stim.exec(`ios-${workspace.label}`, workspace.path, ['ios', '--json'], { timeoutMs });
  const record = ctx.record(workspace);
  Object.assign(record, {
    startExit: started.code,
    iosExit: ios.code,
    iosMs: ios.ms,
    launchedAt: ios.endedAt,
    cacheHit: ios.json?.cacheHit ?? null,
    launched: ios.json?.launched ?? null,
    udid: ios.json?.udid ?? null,
    errorCode: ios.ok ? null : (ios.json?.code ?? 'no JSON failure payload'),
    workspaceDir: ios.json?.logs?.dir ? dirname(ios.json.logs.dir) : null,
  });
  record.derivedDataAfterLaunch = record.workspaceDir ? hasEntries(join(record.workspaceDir, 'derived-data')) : null;
  ctx.emit(
    'launch',
    `${workspace.label}: stim ios exit ${ios.code} in ${Math.round(ios.ms / 1000)} s (cache ${ios.json?.cacheHit ?? 'n/a'}, launched ${ios.json?.launched ?? 'n/a'})`,
  );
  return { started, ios, ok: started.ok && ios.ok };
}

function analyzeIdle(ctx, item) {
  const entry = {
    ...item,
    resolved: null,
    previousPollStartMs: null,
    previousPressure: null,
    activityMs: null,
    activityReadMs: null,
  };
  for (const poll of ctx.snapshots) {
    if (!poll.ok || poll.startedAt < item.commandEndMs) continue;
    const env = poll.envs[item.workspace.path];
    if (!env) continue;
    if (env.facts.idle) {
      entry.resolved = { facts: env.facts, poll };
      break;
    }
    entry.previousPollStartMs = poll.startedAt;
    entry.previousPressure = poll.pressureLevel;
    const at = env.facts.lastActivityMs;
    if (at !== null && at >= (entry.activityMs ?? 0)) {
      entry.activityMs = at;
      entry.activityReadMs = poll.endedAt;
    }
  }
  return entry;
}

export async function waitForIdle(ctx, items, { windowMs, graceMs }) {
  ctx.setStage('idle-wait');
  const end = Math.max(...items.map((item) => item.commandEndMs)) + windowMs + TICK_MS + graceMs;
  for (;;) {
    const entries = items.map((item) => analyzeIdle(ctx, item));
    if (entries.every((entry) => entry.resolved) || Date.now() > end || ctx.signal.aborted)
      return new Map(entries.map((entry) => [entry.workspace.label, entry]));
    await sleep(POLL_MS, ctx.signal);
  }
}

const WORKING_STAGES = new Set(['running', 'building']);
const COUNTED_METRO_EVENTS = new Set([
  'bundle_response_started',
  'bundle_response_finished',
  'bundle_response_failed',
  'expo_stdout',
  'command_stdout',
]);

function machineAt(ctx, ms) {
  try {
    const rows = parseCsv(readFileSync(join(ctx.out, 'samples.csv'), 'utf8'));
    const row = rows.reduce(
      (best, r) => (Math.abs(r.epoch * 1000 - ms) < Math.abs((best?.epoch ?? 0) * 1000 - ms) ? r : best),
      null,
    );
    return `machine at that moment: memory pressure level ${row?.pressure ?? 'n/a'}, ${row?.home_free_mb == null ? 'n/a' : (row.home_free_mb / 1024).toFixed(1)} GB free on the home volume (high pressure legitimately idles a workspace at 2 minutes)`;
  } catch {
    return 'machine at that moment: no samples';
  }
}

const isPressured = (level) => level === 'high' || level === 'critical';

const readOrEmpty = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

export function readLadder(ctx, workspaces) {
  return ladderActions({
    daemonText: readOrEmpty(join(ctx.home, 'daemon', 'daemon.ndjson')),
    workspaceLogs: workspaces.flatMap((workspace) => {
      const dir = ctx.record(workspace).workspaceDir;
      return dir ? [{ workspace: workspace.path, text: readOrEmpty(join(dir, 'logs', 'metro.ndjson')) }] : [];
    }),
  });
}

function daemonIdleOf(actions, entry) {
  const found = actions.find(
    (action) =>
      action.kind === 'idle-stage' && action.workspace === entry.workspace.path && action.ts >= entry.commandEndMs,
  );
  return found ? { atMs: found.ts, pressure: found.pressure } : null;
}

function idleOutcome(ctx, entry, windowMs, actions) {
  const label = entry.workspace.label;
  if (!entry.resolved) {
    return outcome(
      label,
      STATUS.fail,
      `never reached the idle stage; last working poll at ${entry.previousPollStartMs === null ? 'none' : clock(entry.previousPollStartMs)}`,
    );
  }
  const timing = judgeIdleTiming({
    commandEndMs: entry.commandEndMs,
    lastActivityMs: entry.activityMs,
    readAtMs: entry.activityReadMs ?? entry.commandEndMs,
    windowMs,
    tickMs: TICK_MS,
    previousPollStartMs: entry.previousPollStartMs,
    idlePollStartMs: entry.resolved.poll.startedAt,
    idlePollEndMs: entry.resolved.poll.endedAt,
    pressureLevel:
      [entry.resolved.poll.pressureLevel, entry.previousPressure].find(isPressured) ??
      entry.resolved.poll.pressureLevel,
    daemonIdle: daemonIdleOf(actions, entry),
  });
  const dir = ctx.record(entry.workspace).workspaceDir;
  const newest = dir
    ? newestRecordMs(join(dir, 'logs', 'metro.ndjson'), COUNTED_METRO_EVENTS, entry.resolved.poll.endedAt)
    : null;
  const extra = newest
    ? [
        `newest Metro bundle or stdout record ${clock(newest.at)} (${newest.event}), which builds that predate the new activity definition count as activity`,
      ]
    : [];
  const machine = timing.early ? [machineAt(ctx, entry.resolved.poll.endedAt)] : [];
  return outcome(label, timing.ok ? STATUS.pass : STATUS.fail, ...timing.evidence, ...machine, ...extra);
}

const RECHECK_MS = 10_000;

export async function assertIdleDown(ctx, scenario, waited, windowMs) {
  const A = ctx.assertions;
  const entries = [...waited.values()];
  const { actions } = readLadder(
    ctx,
    entries.map((entry) => entry.workspace),
  );
  const unsettled = entries.some((entry) => entry.resolved && !entry.resolved.facts.stageIdle);
  if (unsettled) await sleep(RECHECK_MS, ctx.signal);
  const later = unsettled ? await pollStatus(ctx) : null;
  A.fromItems(
    scenario,
    'idle-stage',
    `each workspace reaches its idle stage within the window (${Math.round(windowMs / 60000)} min) plus one tick`,
    entries.map((entry) => idleOutcome(ctx, entry, windowMs, actions)),
  );
  A.fromItems(
    scenario,
    'idle-metro-down',
    'Metro is stopped (the idle-stop record is reported as evidence)',
    entries.map((entry) => {
      const f = entry.resolved?.facts;
      if (!f) return outcome(entry.workspace.label, STATUS.fail, 'workspace never went idle');
      return outcome(
        entry.workspace.label,
        f.metroRunning ? STATUS.fail : STATUS.pass,
        `metro.running=${f.metroRunning}, idle stop recorded=${f.metroIdleStop}`,
      );
    }),
  );
  A.fromItems(
    scenario,
    'idle-devices-down',
    'owned devices are shut down',
    entries.map((entry) => {
      const f = entry.resolved?.facts;
      if (!f) return outcome(entry.workspace.label, STATUS.fail, 'workspace never went idle');
      if (f.deviceCount === 0) {
        return outcome(entry.workspace.label, STATUS.unavailable, 'status lists no iOS device for this workspace');
      }
      return outcome(
        entry.workspace.label,
        f.devicesUp === 0 ? STATUS.pass : STATUS.fail,
        `${f.devicesUp} of ${f.deviceCount} devices up, idle shutdown records=${f.idleShutdowns}`,
      );
    }),
  );
  A.fromItems(
    scenario,
    'idle-stage-reported',
    'status reports the idle stage',
    entries.map((entry) => {
      const first = entry.resolved?.facts;
      if (!first) return outcome(entry.workspace.label, STATUS.fail, 'workspace never went idle');
      const rechecked = later?.envs[entry.workspace.path]?.facts;
      const f = !first.stageIdle && rechecked?.stageIdle ? rechecked : first;
      if (f.stageIdle) {
        const freed = f.idleStage ? `, idleStage.freedBytes=${f.idleStage.freedBytes}` : ', dormantStage present';
        const lateNote = f === first ? '' : ' (written after the first idle poll)';
        return outcome(entry.workspace.label, STATUS.pass, `stage.kind=${f.stageKind}${freed}${lateNote}`);
      }
      if (WORKING_STAGES.has(f.stageKind)) {
        return outcome(
          entry.workspace.label,
          STATUS.fail,
          `stage.kind=${f.stageKind} although Metro and the devices are down`,
        );
      }
      return outcome(
        entry.workspace.label,
        STATUS.unavailable,
        `not available on this build: stage.kind=${f.stageKind}, which is not an idle stage`,
      );
    }),
  );
  A.fromItems(
    scenario,
    'idle-derived-data-gone',
    'the workspace DerivedData is deleted by the idle stop',
    entries.map((entry) => {
      const label = entry.workspace.label;
      const record = ctx.record(entry.workspace);
      if (!entry.resolved) return outcome(label, STATUS.fail, 'workspace never went idle');
      if (!record.derivedDataAfterLaunch)
        return outcome(
          label,
          STATUS.unavailable,
          'no derived-data directory existed after launch, so there was nothing to delete (cache-hit run)',
        );
      const before = record.derivedDataAfterLaunch;
      const after = hasEntries(join(record.workspaceDir, 'derived-data'));
      return outcome(
        label,
        after ? STATUS.fail : STATUS.pass,
        `derived-data present after launch=${before}, after idle=${after}`,
      );
    }),
  );
}

function reviveFacts(result) {
  const revived = result.json?.revived;
  const devices = revived?.devices ?? [];
  return { restarted: revived?.metro?.restarted ?? null, devices };
}

export async function reviveWorkspaces(ctx, scenario, workspaces, { concurrent }) {
  ctx.setStage('revive');
  const runOne = (workspace) =>
    ctx.stim.exec(`revive-${workspace.label}`, workspace.path, ['revive', '--json'], { timeoutMs: 20 * 60_000 });
  const results = [];
  const states = [];
  const checkAfter = async () => {
    await sleep(3000, ctx.signal);
    return pollStatus(ctx);
  };
  if (concurrent) {
    results.push(...(await Promise.all(workspaces.map(runOne))));
    const snapshot = await checkAfter();
    for (const workspace of workspaces) states.push(snapshot.envs[workspace.path].facts);
  } else {
    for (const workspace of workspaces) {
      results.push(await runOne(workspace));
      states.push((await checkAfter()).envs[workspace.path].facts);
    }
  }
  const items = workspaces.map((workspace, index) => {
    const result = results[index];
    const facts = reviveFacts(result);
    const state = states[index];
    ctx.record(workspace).reviveExit = result.code;
    ctx.record(workspace).reviveMs = result.ms;
    ctx.record(workspace).revivedAt = result.endedAt;
    const launchedOk =
      facts.devices.length > 0 &&
      facts.devices.every((device) => device.app?.launched === true || device.app?.launched === 'bundling');
    const evidence = [
      `exit ${result.code} in ${Math.round(result.ms / 1000)} s${result.json?.code ? `, ${result.json.code}` : ''}`,
      `metro restarted=${facts.restarted}, devices=${facts.devices.map((device) => `${device.rebooted ? 'rebooted' : 'kept'}/${device.app?.launched}`).join(',') || 'none'}`,
      `status after: metro.running=${state.metroRunning}, devices up=${state.devicesUp}, app running=${state.appRunning}`,
    ];
    const ok = result.ok && facts.restarted === true && launchedOk && state.metroRunning && state.devicesUp > 0;
    return outcome(workspace.label, ok ? STATUS.pass : STATUS.fail, ...evidence);
  });
  ctx.assertions.fromItems(scenario, 'revive', '`stim revive` restores Metro, the device and the app', items);
}
