import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
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
import { runMaintenance } from '../stimd/passes/run.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { requestDaemonTick, stimdRefused } from './client.ts';
import { runBootedParkedPass } from './booted-parked.ts';
import { runDormantDependencies } from './dependencies.ts';
import { createFingerprintPrecompute, type PrecomputeInput } from './fingerprint-precompute.ts';
import { daemonMode } from './mode.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { idleOutputBytes, runLadder } from './ladder.ts';
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
  signal,
}: {
  act: boolean;
  log: IdlePassInput['log'];
  memoryWarningSince?: string | null;
  signal?: AbortSignal;
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
  const operation = processContext(process.cwd(), signal ?? new AbortController().signal);
  const measured = await measureTick(config, now, { signal: operation.signal, operation });
  operation.signal.throwIfAborted();
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
  const memoryLevel = measured.measurement.memory.level;
  const parkedActions = await runBootedParkedPass({
    sims: measured.sims,
    memory: memoryLevel !== 'normal' ? memoryLevel : pressure.memory !== 'normal' ? 'warning' : memoryLevel,
    act,
    log,
    operation,
  });
  operation.signal.throwIfAborted();
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
  operation.signal.throwIfAborted();
  const actions: DaemonLadderAction[] = [
    ...parkedActions,
    ...(pressure.level === 'normal'
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
        )),
  ];
  const idleMs = lap();
  const reading = { devices: measured.devices, simsFailed: measured.sims === null, operation };
  actions.push(...(await runDormantPass({ config, act, log, ...reading })));
  operation.signal.throwIfAborted();
  const dormantMs = lap();
  if (config && pressure.level !== 'normal') {
    const ladder = await runLadder(
      {
        config,
        act,
        log,
        ...reading,
        sims: measured.sims,
        remeasure: async () => {
          const results = await Promise.allSettled([
            measureDisk(config, operation.signal),
            measureMemory(operation.signal, operation),
          ]);
          const cleanup = results.find((result) => result.status === 'rejected' && isClaimUnavailable(result.reason));
          if (cleanup?.status === 'rejected') throw cleanup.reason;
          operation.signal.throwIfAborted();
          if (results[0].status === 'rejected') throw results[0].reason;
          if (results[1].status === 'rejected') throw results[1].reason;
          const [disk, memory] = [results[0].value, results[1].value];
          return classify({ disk, memory });
        },
      },
      pressure,
    );
    actions.push(...ladder.actions);
    pressure = ladder.pressure;
  }
  operation.signal.throwIfAborted();
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
  start(passes: Pick<HomePasses, 'config' | 'measured' | 'operation' | 'workspaces' | 'pressure'>, act: boolean): void;
  running(): boolean;
  /** The actions the slow passes took since the last call. */
  take(): DaemonLadderAction[];
  /** Resolves once no slow pass runs. */
  settled(): Promise<void>;
}

/**
 * The daemon's slow passes, beside its tick instead of in it: the fingerprint precompute of the live workspaces whose
 * HEAD, lockfile or install stamp changed, the dormant stage's dependency step and an automatic maintenance pass, from the
 * measurement of the tick that started them, one at a time, so a slow git fetch, `gh` call or size scan never holds
 * the tick that serves waiting runs. Each logs a `daemon_maintenance` record with its phases; one that throws is
 * logged and the next tick starts them again.
 */
export function createMaintenanceLane(
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    msg: string,
    fields?: Record<string, unknown>,
  ) => void,
  precompute: { run(input: PrecomputeInput, act: boolean): Promise<void> } = createFingerprintPrecompute(log),
): MaintenanceLane {
  let current: Promise<void> | null = null;
  let failure: unknown;
  let taken: DaemonLadderAction[] = [];
  return {
    start({ config, measured, operation, workspaces, pressure }, act) {
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
        await precompute.run({ config, workspaces, pressure, operation }, act).catch((error: unknown) => {
          if (isClaimUnavailable(error)) throw error;
          operation.signal.throwIfAborted();
          log('warn', 'daemon_fingerprint_precompute', error instanceof Error ? error.message : String(error));
        });
        const fingerprintMs = lap();
        const deleted = await runDormantDependencies({ config, act, log, ...reading });
        taken.push(...deleted);
        const dependenciesMs = lap();
        const skipped = await runMaintenance('daemon', { report: !act, tick: { operation, measured } });
        const maintenanceMs = lap();
        const tookMs = Math.round(performance.now() - started);
        log('debug', 'daemon_maintenance', `maintenance ${tookMs}ms${skipped ? `; skipped: ${skipped}` : ''}`, {
          tookMs,
          phases: { fingerprintMs, dependenciesMs, maintenanceMs },
          eventLoopDelay: {
            maxMs: Math.round(loopDelay.max / 1e6),
            p99Ms: Math.round(loopDelay.percentile(99) / 1e6),
          },
          ...(skipped ? { skipped } : {}),
        });
      })()
        .catch((error: unknown) => {
          if (error instanceof Error && 'reportCleanup' in error) failure = error;
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
      if (failure) throw failure;
    },
  };
}

/**
 * The pressure ladder in this process, for a command with no daemon holding the home: from rung 2, because rung 1's
 * idle stage is the daemon's activity pass. Measures and lists devices only when the level is above normal, and
 * nothing while `daemon.mode` is off. Logs to `daemon.ndjson` under `trigger`.
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
        sims: measured.sims,
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
 * Runs the pressure ladder now: one daemon tick when a daemon runs, else, unless a stimd of another build refused this
 * process and runs its own, the ladder in this process, which never takes `protectedRoot`.
 */
export async function runLadderNow(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  protectedRoot?: string,
): Promise<void> {
  if ((await requestDaemonTick(env, signal)) || stimdRefused()) return;
  signal?.throwIfAborted();
  try {
    await runCommandLadder('command', env, protectedRoot);
  } catch {}
}
