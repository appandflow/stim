import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LOG_ROTATE_BYTES, type StimContext } from '@stim-cli/core';
import {
  daemonNdjsonFile,
  readDaemonSnapshot,
  type DaemonLadderAction,
  type DaemonPressure,
  type DaemonWorkspaceDecision,
} from '@stim-cli/core/state';
import { processContext } from '../cli-operation.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { daemonClaimHeld, requestDaemonTick } from './client.ts';
import { commandWorkspace } from './command-workspace.ts';
import { runDormantDependencies } from './dependencies.ts';
import { daemonMode } from './mode.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { idleOutputBytes, runLadder } from './ladder.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from './passes-guard-env.ts';
import { measureDisk, measureMemory, measureTick, type TickMeasurement } from './measure.ts';
import { classifyPressure, diskThresholds } from './pressure.ts';
import { runDormantPass } from './stages.ts';

interface HomePassPhases {
  measureMs: number;
  idleMs: number;
  dormantMs: number;
  ladderMs: number;
}

export interface HomePasses {
  config: Config | null;
  now: number;
  measured: TickMeasurement;
  workspaces: DaemonWorkspaceDecision[];
  pressure: DaemonPressure;
  actions: DaemonLadderAction[];
  phases: HomePassPhases;
  operation: StimContext;
}

/**
 * One measurement, the activity pass (the idle stage, taking every workspace idle 2 minutes while the level is high
 * or critical, then the dormant stage) and the pressure ladder while the level stays above normal, in this process, as
 * the daemon runs them each tick. `act: false` decides and logs without acting. `memoryWarningSince` carries the
 * memory warning clock from the last tick.
 */
export async function runHomePasses({
  act,
  log,
  memoryWarningSince = null,
}: {
  act: boolean;
  log: IdlePassInput['log'];
  memoryWarningSince?: string | null;
}): Promise<HomePasses> {
  let mark = performance.now();
  const lap = () => {
    const at = performance.now();
    const ms = Math.round(at - mark);
    mark = at;
    return ms;
  };
  const config = loadConfig();
  const now = Date.now();
  const operation = processContext(process.cwd(), new AbortController().signal);
  const measured = await measureTick(config, now);
  const measureMs = lap();
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
    operation,
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
  const idleMs = lap();
  const reading = { devices: measured.devices, simsFailed: measured.sims === null, operation };
  actions.push(...(await runDormantPass({ config, act, log, ...reading })));
  const dormantMs = lap();
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
  const ladderMs = lap();
  return {
    config,
    now,
    measured,
    workspaces,
    pressure,
    actions,
    phases: { measureMs, idleMs, dormantMs, ladderMs },
    operation,
  };
}

export interface MaintenanceLane {
  /** Starts the slow passes from this tick's passes, unless the last ones still run. */
  start(passes: HomePasses, act: boolean): void;
  running(): boolean;
  /** The actions the slow passes took since the last call. */
  take(): DaemonLadderAction[];
  /** Resolves once no slow pass runs. */
  settled(): Promise<void>;
}

/**
 * The daemon's slow passes, beside its tick instead of in it: the dormant stage's dependency step and an automatic
 * maintenance pass, from the measurement of the tick that started them, one at a time, so a slow git fetch, `gh` call
 * or size scan never holds the tick that serves waiting runs. Each logs a `daemon_maintenance` record with its
 * phases; one that throws is logged and the next tick starts them again.
 */
export function createMaintenanceLane(
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    msg: string,
    fields?: Record<string, unknown>,
  ) => void,
): MaintenanceLane {
  let current: Promise<void> | null = null;
  let taken: DaemonLadderAction[] = [];
  return {
    start({ config, measured, operation }, act) {
      if (current) return;
      const started = performance.now();
      let mark = started;
      const lap = () => {
        const at = performance.now();
        const ms = Math.round(at - mark);
        mark = at;
        return ms;
      };
      const loopDelay = monitorEventLoopDelay();
      loopDelay.enable();
      current = (async () => {
        const reading = { devices: measured.devices, simsFailed: measured.sims === null, operation };
        const deleted = await runDormantDependencies({ config, act, log, ...reading });
        taken.push(...deleted);
        const dependenciesMs = lap();
        const skipped = await runMaintenance('daemon', { report: !act, tick: { operation, measured } });
        const maintenanceMs = lap();
        const tookMs = Math.round(performance.now() - started);
        log('debug', 'daemon_maintenance', `maintenance ${tookMs}ms${skipped ? `; skipped: ${skipped}` : ''}`, {
          tookMs,
          phases: { dependenciesMs, maintenanceMs },
          eventLoopDelay: {
            maxMs: Math.round(loopDelay.max / 1e6),
            p99Ms: Math.round(loopDelay.percentile(99) / 1e6),
          },
          ...(skipped ? { skipped } : {}),
        });
      })()
        .catch((error: unknown) => {
          log('warn', 'daemon_maintenance_failed', error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          loopDelay.disable();
          current = null;
        });
    },
    running: () => current !== null,
    take() {
      const actions = taken;
      taken = [];
      return actions;
    },
    settled: async () => {
      await current;
    },
  };
}

/**
 * The pressure ladder in this process, for a command with no daemon holding the home: from rung 2, because the idle
 * stage of rung 1 is the activity pass, which a command runs only for workspaces with no dev server
 * (`runCommandIdle`). Measures and lists devices only when the level is above normal, and nothing while `daemon.mode`
 * is off. Logs to `daemon.ndjson` under `trigger`.
 */
async function runCommandLadder(trigger: string, env: NodeJS.ProcessEnv, protectedRoot?: string): Promise<void> {
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
        ...(protectedRoot ? { protectedRoot } : {}),
      },
      pressure,
    );
  } finally {
    writer.close();
  }
}

/**
 * The activity pass in this process, for a command with no daemon holding the home, over the workspaces whose dev
 * server does not run: an owned device left booted after its dev server stopped, or after a Release run, goes into
 * the idle stage after `idle.minutes` of the one activity clock. Dev servers keep their own supervisor's timer.
 * Logs to `daemon.ndjson` under `trigger`.
 */
async function runCommandIdle(trigger: string, env: NodeJS.ProcessEnv, protectedRoot?: string): Promise<void> {
  const mode = daemonMode(env);
  const config = loadConfig();
  if (!config || mode === 'off') return;
  const now = Date.now();
  const measured = await measureTick(config, now);
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  try {
    await runIdlePass({
      config,
      now,
      sims: measured.sims,
      simsError: measured.simsError,
      devices: measured.devices,
      act: mode === 'on',
      unsupervised: true,
      ...(protectedRoot ? { protectedRoot } : {}),
      log: (level, event, msg, fields = {}) => writer.write({ src: trigger, level, event, msg, ...fields }),
    });
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

/**
 * Runs the pressure ladder now: one daemon tick when a daemon runs, else the ladder in this process, which never takes
 * `protectedRoot`.
 */
export async function runLadderNow(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  protectedRoot?: string,
): Promise<void> {
  if (await requestDaemonTick(env, signal)) return;
  signal?.throwIfAborted();
  try {
    await runCommandLadder('command', env, protectedRoot);
  } catch {}
}

/**
 * Automatic maintenance, the activity pass over workspaces with no running dev server, and the pressure ladder at
 * command time, for a command that found no daemon holding the home: Windows, which has none, or a daemon that could
 * not start. Nothing runs while `daemon.mode` is off, and report acts on nothing. Each dev server supervisor times
 * its own idle stop. No pass takes `protectedRoot`, the command's own workspace.
 */
export async function runPassesInProcess(
  trigger: string,
  env: NodeJS.ProcessEnv = process.env,
  protectedRoot: string | null = commandWorkspace(false, env),
): Promise<void> {
  try {
    const mode = daemonMode(env);
    if (env[HOME_PASSES_TEST_GUARD_ENV] || mode === 'off' || daemonClaimHeld()) return;
    await runCommandIdle(trigger, env, protectedRoot ?? undefined);
    await runMaintenance(trigger, { report: mode === 'report' });
    await runCommandLadder(trigger, env, protectedRoot ?? undefined);
  } catch {}
}
