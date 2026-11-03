import { LOG_ROTATE_BYTES, type StimContext } from '@stim-cli/core';
import {
  daemonNdjsonFile,
  readDaemonSnapshot,
  type DaemonLadderAction,
  type DaemonPressure,
  type DaemonWorkspaceDecision,
} from '@stim-cli/core/state';
import { runMaintenance } from '../maintenance/run.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { daemonClaimHeld, requestDaemonTick } from './client.ts';
import { daemonMode } from './mode.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { idleOutputBytes, runLadder } from './ladder.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from './passes-guard-env.ts';
import { measureDisk, measureMemory, measureTick, type TickMeasurement } from './measure.ts';
import { classifyPressure, diskThresholds } from './pressure.ts';
import { runDormantPass } from './stages.ts';

export interface HomePasses {
  config: Config | null;
  now: number;
  measured: TickMeasurement;
  workspaces: DaemonWorkspaceDecision[];
  pressure: DaemonPressure;
  actions: DaemonLadderAction[];
}

/**
 * One measurement, the activity pass (the idle stage, taking every workspace idle 2 minutes while the level is high
 * or critical, then the dormant stage), the pressure ladder while the level stays above normal, and an automatic
 * maintenance pass, in this process, as the daemon runs them each tick. `act: false` decides and logs without
 * acting. `memoryWarningSince` carries the memory warning clock from the last tick.
 */
export async function runHomePasses({
  act,
  trigger,
  log,
  memoryWarningSince = null,
}: {
  act: boolean;
  trigger: string;
  log: IdlePassInput['log'];
  memoryWarningSince?: string | null;
}): Promise<HomePasses> {
  const config = loadConfig();
  const now = Date.now();
  const measured = await measureTick(config, now);
  const { thresholds, error } = diskThresholds(config);
  if (error) log('warn', 'pressure_settings_invalid', `${error}; that disk threshold is off until it is fixed`);
  let warningSince = memoryWarningSince;
  const classify = (measurement: Pick<TickMeasurement['measurement'], 'disk' | 'memory'>): DaemonPressure => {
    const pressure = classifyPressure({
      ...measurement,
      thresholds,
      previousWarningSince: warningSince,
      now: Date.now(),
    });
    warningSince = pressure.memoryWarningSince;
    return pressure;
  };
  let pressure = classify(measured.measurement);
  const workspaces = await runIdlePass({
    config,
    now,
    sims: measured.sims,
    simsError: measured.simsError,
    devices: measured.devices,
    act,
    log,
    ...(pressure.level === 'normal' ? {} : { pressure: { level: pressure.level, reasons: pressure.reasons } }),
  });
  const actions: DaemonLadderAction[] =
    pressure.level === 'normal'
      ? []
      : workspaces.flatMap((entry) =>
          entry.outcome === 'idle' || entry.outcome === 'would-idle'
            ? [
                {
                  rung: 1,
                  kind: 'idle-stage',
                  target: entry.path,
                  workspace: entry.path,
                  outcome: entry.outcome === 'idle' ? ('done' as const) : ('would' as const),
                  bytes: entry.freedBytes ?? 0,
                  detail: entry.detail,
                  ...(entry.outcome === 'idle' ? { restore: 'stim revive' } : {}),
                },
              ]
            : [],
        );
  const reading = { devices: measured.devices, simsFailed: measured.sims === null };
  actions.push(...(await runDormantPass({ config, act, log, ...reading })));
  if (config && pressure.level !== 'normal') {
    const ladder = await runLadder(
      {
        config,
        act,
        log,
        ...reading,
        remeasure: async () => {
          const [disk, memory] = await Promise.all([measureDisk(config), measureMemory()]);
          return classify({ disk, memory });
        },
      },
      pressure,
    );
    actions.push(...ladder.actions);
    pressure = ladder.pressure;
  }
  await runMaintenance(trigger, { report: !act });
  return { config, now, measured, workspaces, pressure, actions };
}

/**
 * The pressure ladder in this process, for a command with no daemon holding the home: from rung 2, because the idle
 * stage of rung 1 is the activity pass, which only the daemon runs. Measures and lists devices only when the level is
 * above normal, and nothing while `daemon.mode` is off. Logs to `daemon.ndjson` under `trigger`.
 */
async function runCommandLadder(trigger: string, env: NodeJS.ProcessEnv): Promise<void> {
  const mode = daemonMode(env);
  const config = loadConfig();
  if (!config || mode === 'off') return;
  const { thresholds } = diskThresholds(config, env);
  let warningSince = readDaemonSnapshot()?.pressure?.memoryWarningSince ?? null;
  const classify = async () => {
    const [disk, memory] = await Promise.all([measureDisk(config), measureMemory()]);
    const pressure = classifyPressure({
      disk,
      memory,
      thresholds,
      previousWarningSince: warningSince,
      now: Date.now(),
    });
    warningSince = pressure.memoryWarningSince;
    return pressure;
  };
  const pressure = await classify();
  if (pressure.level === 'normal') return;
  const measured = await measureTick(config, Date.now());
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  try {
    await runLadder(
      {
        config,
        act: mode === 'on',
        log: (level, event, msg, fields = {}) => writer.write({ src: trigger, level, event, msg, ...fields }),
        devices: measured.devices,
        simsFailed: measured.sims === null,
        remeasure: classify,
        fromRung: 2,
      },
      pressure,
    );
  } finally {
    writer.close();
  }
}

export interface ForcedLadder {
  /** The level the machine measures now; the forced run ignores it. */
  pressure: DaemonPressure;
  /** Each workspace with something running, as the activity pass decides at `idle.minutes`; empty when acting. */
  running: DaemonWorkspaceDecision[];
  levels: { level: 'high' | 'critical'; actions: DaemonLadderAction[] }[];
}

/**
 * The pressure ladder forced to each of `levels` whatever the machine measures, every rung in order without stopping
 * once the level clears: the idle stage for every workspace idle 2 minutes or more, then rungs 1 to 6 (rung 5 only at
 * critical). `stim gc --delete` runs one level with `act`; `stim gc` previews both from one measurement, measuring what
 * each action would free. Logs to `daemon.ndjson` under `trigger` when acting. Null without a Stim config.
 */
export async function runForcedLadder({
  levels,
  act,
  why,
  trigger,
  parkedOlderThanDays,
  operation,
}: {
  levels: readonly ('high' | 'critical')[];
  act: boolean;
  why: string;
  trigger: string;
  /** Takes only the devices parked at least this many days ago, as `gc --older-than` asks. */
  parkedOlderThanDays?: number;
  operation?: StimContext;
}): Promise<ForcedLadder | null> {
  const config = loadConfig();
  if (!config) return null;
  const now = Date.now();
  const measured = await measureTick(config, now, { probe: act });
  const { thresholds } = diskThresholds(config);
  const pressure = classifyPressure({
    ...measured.measurement,
    thresholds,
    previousWarningSince: readDaemonSnapshot()?.pressure?.memoryWarningSince ?? null,
    now,
  });
  const writer = act ? createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES }) : null;
  const log: IdlePassInput['log'] = (logLevel, event, msg, fields = {}) =>
    writer?.write({ src: trigger, level: logLevel, event, msg, ...fields });
  try {
    const reading = {
      config,
      now,
      sims: measured.sims,
      simsError: measured.simsError,
      devices: measured.devices,
      log,
    };
    const running = act ? [] : await runIdlePass({ ...reading, act: false });
    const result: ForcedLadder['levels'] = [];
    for (const level of levels) {
      const actions: DaemonLadderAction[] = [];
      for (const entry of await runIdlePass({ ...reading, act, pressure: { level, reasons: [why] } })) {
        if (entry.outcome !== 'idle' && entry.outcome !== 'would-idle' && entry.outcome !== 'failed') continue;
        actions.push({
          rung: 1,
          kind: 'idle-stage',
          target: entry.path,
          workspace: entry.path,
          outcome: entry.outcome === 'idle' ? 'done' : entry.outcome === 'would-idle' ? 'would' : 'failed',
          bytes: entry.freedBytes ?? (entry.outcome === 'would-idle' ? await idleOutputBytes(entry.path, config) : 0),
          detail: entry.outcome === 'would-idle' ? 'stim gc --delete would do this' : entry.detail,
          ...(entry.outcome === 'idle' ? { restore: 'stim revive' } : {}),
        });
      }
      const ladder = await runLadder(
        {
          config,
          act,
          log,
          devices: measured.devices,
          sims: measured.sims,
          simsFailed: measured.sims === null,
          remeasure: async () => pressure,
          force: { level, why, ...(parkedOlderThanDays === undefined ? {} : { parkedOlderThanDays }) },
          measure: !act,
          operation,
        },
        pressure,
      );
      result.push({ level, actions: [...actions, ...ladder.actions] });
    }
    return { pressure, running, levels: result };
  } finally {
    writer?.close();
  }
}

/** Runs the pressure ladder now: one daemon tick when a daemon runs, else the ladder in this process. */
export async function runLadderNow(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (await requestDaemonTick(env, signal)) return;
  signal?.throwIfAborted();
  try {
    await runCommandLadder('command', env);
  } catch {}
}

/**
 * Automatic maintenance and the pressure ladder at command time, for a command that found no daemon holding the
 * home: Windows, which has none, or a daemon that could not start. Nothing runs while `daemon.mode` is off, and report
 * acts on nothing. The activity pass, idle stage included, is the daemon's alone; without one, each dev server
 * supervisor times its own idle stop. The pass never stops the command's own workspace.
 */
export async function runPassesInProcess(trigger: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const mode = daemonMode(env);
    if (env[HOME_PASSES_TEST_GUARD_ENV] || mode === 'off' || daemonClaimHeld()) return;
    await runMaintenance(trigger, { report: mode === 'report' });
    await runCommandLadder(trigger, env);
  } catch {}
}
