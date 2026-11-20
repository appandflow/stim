import { isClaimUnavailable, releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { LOG_ROTATE_BYTES, type StimContext } from '@stim-cli/core';
import {
  daemonNdjsonFile,
  ladderRunClaims,
  readDaemonSnapshot,
  type DaemonLadderAction,
  type DaemonPressure,
  type DaemonWorkspaceDecision,
  type PressureLevel,
} from '@stim-cli/core/state';
import { processContext } from '../cli-operation.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { checkoutRootOf } from '../workspace/checkout-role.ts';
import { forgetGitReads, openGitReads } from '../workspace/git-reads.ts';
import { launchersOf, launchingOf, logLauncherProblems } from '../workspace/launchers.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { requestDaemonTick, stimdRefused } from './client.ts';
import { runBootedParkedPass } from './booted-parked.ts';
import { runDormantDependencies } from './dependencies.ts';
import { createFingerprintPrecompute, type PrecomputeInput } from './fingerprint-precompute.ts';
import { daemonMode } from './mode.ts';
import { onDiskVolumes, runIdlePass, type IdlePassInput } from './idle.ts';
import { watchedStep } from './step-timing.ts';
import { idleOutputBytes, runLadder } from './ladder.ts';
import { measureDisk, measureMemory, measureTick, type TickMeasurement } from './measure.ts';
import { classifyPressure, diskPressure, diskThresholds, shortVolumeDevices, type DiskThresholds } from './pressure.ts';
import { onShortVolume } from '../stimd/passes/unowned.ts';
import { dormantAfterMs, runDormantPass, sourceDormantAfterMs } from './stages.ts';
import {
  admitStep,
  createDormantGate,
  holdLadder,
  releaseLadder,
  releaseStep,
  stepHeldMs,
  takeLadder,
} from './dormant-gate.ts';

const LADDER_PACE_FACTOR = 4;
const LADDER_PACE_MAX_MS = 15 * 60_000;
const LADDER_PACE_DISK_DROP_MB = 1024;
const LADDER_PACE_SHORT_DROP_MB = 256;
const LADDER_CRITICAL_WAIT_MS = 60_000;
const RANK: Record<PressureLevel, number> = { normal: 0, high: 1, critical: 2 };
/** How long the lane's dormant step may keep a ladder pass for disk waiting. */
const DORMANT_STEP_LIMIT_MS = 10 * 60_000;

/** What a stimd tick shares with its maintenance lane so the dormant step never runs beside a disk ladder pass. */
interface DormantTurn {
  gate: BigInt64Array;
  cadence: BigInt64Array;
  /** Stops the lane's running job and resolves once it has settled. */
  yieldLane: () => Promise<void>;
}

/**
 * Takes the turn for a ladder pass's disk rungs. While the lane's dormant step holds it the pass leaves its disk rungs
 * out, unless a command at the hard floor asked for the tick, which stops the step and gives its hour back, or the step
 * has held the turn DORMANT_STEP_LIMIT_MS, which stops it at its next check and leaves it to its next hour.
 */
async function holdForLadder(
  { gate, cadence, yieldLane }: DormantTurn,
  requested: boolean,
  log: IdlePassInput['log'],
): Promise<boolean> {
  if (holdLadder(gate)) return true;
  const heldMs = stepHeldMs(gate);
  if (!requested && heldMs < DORMANT_STEP_LIMIT_MS) {
    log('debug', 'pressure_ladder_deferred', 'the dormant step holds the turn; the disk rungs wait for it', {
      heldMs,
    });
    return false;
  }
  await yieldLane();
  if (requested) Atomics.store(cadence, 0, 0n);
  takeLadder(gate);
  return true;
}

interface HomePassPhases {
  measureMs: number;
  idleMs: number;
  dormantMs: number;
  ladderMs: number;
}

/**
 * The last pressure ladder pass: the disk and memory levels and each measured volume's free disk and level it started
 * at, keyed by device id, whether an action freed bytes, how long it took and when it ended.
 */
export interface LadderPass {
  disk: PressureLevel;
  memory: PressureLevel;
  volumes: Record<string, { freeMb: number; level: PressureLevel }>;
  freed: boolean;
  durationMs: number;
  endedAt: number;
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
  /** The ladder pass to hand to the next tick as `lastLadder`; null while the level is normal. */
  ladder: LadderPass | null;
}

function volumeReadings(
  measurement: TickMeasurement['measurement'],
  thresholds: DiskThresholds,
): LadderPass['volumes'] {
  return Object.fromEntries(
    measurement.disk.map((volume) => [
      String(volume.device ?? volume.volume),
      { freeMb: volume.freeMb, level: diskPressure([volume], thresholds).level },
    ]),
  );
}

function ladderDue(last: LadderPass, pressure: DaemonPressure, volumes: LadderPass['volumes'], now: number): boolean {
  if (last.freed || RANK[pressure.disk] > RANK[last.disk] || RANK[pressure.memory] > RANK[last.memory]) return true;
  for (const [key, volume] of Object.entries(volumes)) {
    const before = last.volumes[key];
    const dropMb = volume.level === 'normal' ? LADDER_PACE_DISK_DROP_MB : LADDER_PACE_SHORT_DROP_MB;
    if (!before || before.freeMb - volume.freeMb >= dropMb || RANK[volume.level] > RANK[before.level]) return true;
  }
  const maxWaitMs = pressure.level === 'critical' ? LADDER_CRITICAL_WAIT_MS : LADDER_PACE_MAX_MS;
  return now - last.endedAt >= Math.min(maxWaitMs, LADDER_PACE_FACTOR * last.durationMs);
}

/**
 * One measurement, the activity pass (the idle stage, taking every workspace idle 2 minutes while the memory level is
 * high or critical and deleting only outputs on a short volume while disk alone is, then the dormant stage) and the
 * pressure ladder while the level stays above normal, in this process, as the daemon runs them each tick. `act: false` decides and logs without acting. `memoryWarningSince` carries the
 * memory warning clock from the last tick. After a ladder pass that freed nothing (`lastLadder`), the ladder waits
 * four times that pass's duration, at most 15 minutes or, while the level is critical, one minute, before it runs again,
 * unless the disk or memory level rose, a measured volume is new, reached a higher level or lost free space since that
 * pass (256 MB on a volume under pressure, 1 GB on any other), or `requested` says a command asked for this tick.
 * With `dormant`, a ladder pass takes the turn before its first disk rung, and leaves its disk rungs out while the
 * maintenance lane's dormant step holds it (`holdForLadder`).
 */
export async function runHomePasses(input: HomePassesInput): Promise<HomePasses> {
  const operation = processContext(process.cwd(), input.signal ?? new AbortController().signal);
  const closeGitReads = openGitReads(operation);
  try {
    return await homePasses(input, operation);
  } finally {
    closeGitReads();
  }
}

interface HomePassesInput {
  act: boolean;
  log: IdlePassInput['log'];
  memoryWarningSince?: string | null;
  signal?: AbortSignal;
  lastLadder?: LadderPass | null;
  requested?: boolean;
  /** The stim-daemon's share with its maintenance lane; without it no dormant step runs in the tick. */
  dormant?: DormantTurn;
}

async function homePasses(
  { act, log, memoryWarningSince = null, lastLadder = null, requested = false, dormant }: HomePassesInput,
  operation: StimContext,
): Promise<HomePasses> {
  let mark = performance.now();
  const lap = () => {
    const at = performance.now();
    const ms = Math.round(at - mark);
    mark = at;
    return ms;
  };
  const config = loadConfig();
  const now = Date.now();
  const measured = await watchedStep(log, 'measure', () =>
    measureTick(config, now, { signal: operation.signal, operation }),
  );
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
  const parkedActions = await watchedStep(log, 'booted_parked', () =>
    runBootedParkedPass({
      sims: measured.sims,
      memory: memoryLevel !== 'normal' ? memoryLevel : pressure.memory !== 'normal' ? 'warning' : memoryLevel,
      act,
      log,
      operation,
    }),
  );
  operation.signal.throwIfAborted();
  const workspaces = await watchedStep(log, 'idle_stage', () =>
    runIdlePass({
      config,
      now,
      sims: measured.sims,
      simsError: measured.simsError,
      devices: measured.devices,
      act,
      log,
      operation,
      // @ref LLP 0001#the-2-minute-idle-stop-is-for-memory -- a stop frees memory, not disk
      ...(pressure.memory !== 'normal'
        ? { pressure: { level: pressure.memory, reasons: pressure.reasons } }
        : pressure.disk !== 'normal'
          ? // @ref LLP 0001#each-rung-frees-only-the-volumes-under-pressure -- memory pressure idles every workspace
            { disk: { volumes: shortVolumeDevices(measured.measurement.disk, thresholds, 'high') } }
          : {}),
    }),
  );
  operation.signal.throwIfAborted();
  const actions: DaemonLadderAction[] = [
    ...parkedActions,
    ...(pressure.memory === 'normal'
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
  if (act) forgetGitReads(operation);
  const reading = { devices: measured.devices, simsFailed: measured.sims === null, operation };
  actions.push(...(await runDormantPass({ config, act, log, ...reading })));
  operation.signal.throwIfAborted();
  const dormantMs = lap();
  let ladderPass: LadderPass | null = null;
  const level = pressure.level;
  const volumes = volumeReadings(measured.measurement, thresholds);
  if (
    config &&
    level !== 'normal' &&
    lastLadder &&
    !requested &&
    !ladderDue(lastLadder, pressure, volumes, Date.now())
  ) {
    ladderPass = lastLadder;
    log(
      'debug',
      'pressure_ladder_paced',
      `the pressure ladder waits: its last pass freed nothing in ${lastLadder.durationMs}ms`,
      { level, lastDurationMs: lastLadder.durationMs, lastEndedAt: new Date(lastLadder.endedAt).toISOString() },
    );
  } else if (config && level !== 'normal') {
    // @ref LLP 0001#the-dormant-step-never-runs-beside-the-ladder -- both walk the same checkouts
    let turn: DormantTurn | undefined;
    const holdTurn = async () => {
      if (!dormant) return true;
      if (await holdForLadder(dormant, requested, log)) turn = dormant;
      return turn !== undefined;
    };
    try {
      const before = pressure;
      const started = Date.now();
      const ladder = await runLadder(
        {
          config,
          act,
          log,
          ...reading,
          sims: measured.sims,
          reports: true,
          beforeDiskRung: holdTurn,
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
      const endedAt = Date.now();
      ladderPass = {
        disk: before.disk,
        memory: before.memory,
        volumes,
        // @ref LLP 0001#a-ladder-pass-that-frees-nothing-waits -- an action that freed no bytes is no progress
        freed: ladder.actions.some((action) => action.outcome === 'done' && action.bytes > 0),
        durationMs: endedAt - started,
        endedAt,
      };
    } finally {
      if (turn) releaseLadder(turn.gate);
    }
  }
  operation.signal.throwIfAborted();
  const ladderMs = lap();
  logLauncherProblems(operation, log);
  return {
    config,
    now,
    measured,
    workspaces,
    pressure,
    actions,
    phases: { measureMs, idleMs, dormantMs, ladderMs },
    operation,
    ladder: ladderPass,
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
 * HEAD, lockfile or install stamp changed, the dormant stage's dependency step, at any level while no ladder pass holds
 * `gate`, and an automatic maintenance pass, from the
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
  dependencyCadence: BigInt64Array = new BigInt64Array(1),
  gate: BigInt64Array = createDormantGate(),
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
        await watchedStep(log, 'fingerprint_precompute', () =>
          precompute.run({ config, workspaces, pressure, operation }, act),
        ).catch((error: unknown) => {
          if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
          operation.signal.throwIfAborted();
          log('warn', 'daemon_fingerprint_precompute', error instanceof Error ? error.message : String(error));
        });
        const fingerprintMs = lap();
        // @ref LLP 0001#the-dormant-step-never-runs-beside-the-ladder -- above normal the tick runs it after its ladder
        if (admitStep(gate))
          try {
            taken.push(...(await runDormantDependencies({ config, act, log, ...reading, cadence: dependencyCadence })));
          } finally {
            releaseStep(gate);
          }
        const dependenciesMs = lap();
        const skipped = await watchedStep(log, 'maintenance', () =>
          runMaintenance('daemon', { report: !act, tick: { operation, measured } }),
        );
        const maintenanceMs = lap();
        logLauncherProblems(operation, log);
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
          const cleanup = error instanceof Error && 'reportCleanup' in error;
          if (cleanup) failure = error;
          if (operation.signal.aborted && !cleanup)
            log('debug', 'daemon_maintenance_aborted', 'the maintenance pass was stopped');
          else log('warn', 'daemon_maintenance_failed', error instanceof Error ? error.message : String(error));
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
async function runCommandLadder(
  trigger: string,
  env: NodeJS.ProcessEnv,
  protectedRoot?: string,
  headroom?: HeadroomRun,
): Promise<void> {
  const mode = daemonMode(env);
  const config = loadConfig();
  if (!config || mode === 'off') return;
  const { thresholds } = diskThresholds(config, env);
  let warningSince = readDaemonSnapshot()?.pressure?.memoryWarningSince ?? null;
  const classify = async (): Promise<DaemonPressure> => {
    if (headroom) return headroomPressure(config, headroom);
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
  const measured = await measureTick(
    config,
    Date.now(),
    headroom ? { probe: false, signal: headroom.stop, operation: headroom.operation } : {},
  );
  const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
  try {
    await runLadder(
      {
        config,
        act: mode === 'on',
        log: (level, event, msg, fields = {}) => {
          if (headroom && event === 'pressure_action' && (fields.outcome === 'done' || fields.outcome === 'failed'))
            headroom.acted = true;
          writer.write({ src: trigger, level, event, msg, ...fields });
        },
        devices: measured.devices,
        sims: measured.sims,
        simsFailed: measured.sims === null,
        remeasure: classify,
        fromRung: 2,
        // @ref LLP 0003#never-from-a-build-command -- the build is about to read those caches
        lastRung: 8,
        ...(protectedRoot ? { protectedRoot } : {}),
        ...(headroom ? { operation: headroom.operation, stop: headroom.stop, volume: headroom.device } : {}),
      },
      pressure,
    );
  } finally {
    writer.close();
  }
}

/** What a ladder run for a build's headroom judges by: the build's device, the target there, and when to stop. */
interface HeadroomRun {
  device: number;
  freeMb: number;
  operation: StimContext;
  /** Aborts when the build is cancelled or the run's deadline passes. */
  stop: AbortSignal;
  /** An action that removed something, or failed, has been logged since the build device was last measured. */
  acted: boolean;
  /** The build device's free space at the last measurement. */
  lastFreeMb: number | null;
  /** Such an action left the build device's free space no higher: the rungs cannot help it, so the run ends. */
  helpless: boolean;
}

const NORMAL_PRESSURE: DaemonPressure = {
  level: 'normal',
  disk: 'normal',
  memory: 'normal',
  reasons: [],
  memoryWarningSince: null,
};

/**
 * The level of a headroom run: high while the build's device has less free than the target, else normal. It ignores
 * every other volume and memory, and is normal once `stop` aborts or once an action that removed something left the
 * build device's free space no higher, which ends the run between two rungs or two actions.
 */
async function headroomPressure(config: Config, headroom: HeadroomRun): Promise<DaemonPressure> {
  if (headroom.stop.aborted || headroom.helpless) return NORMAL_PRESSURE;
  let disk;
  try {
    disk = await measureDisk(config, headroom.stop);
  } catch (error) {
    if (headroom.stop.aborted) return NORMAL_PRESSURE;
    throw error;
  }
  // @ref LLP 0006#only-the-builds-own-device-counts -- other volumes do not help this build
  const volume = disk.find((entry) => entry.device === headroom.device);
  if (!volume) return NORMAL_PRESSURE;
  if (headroom.acted && headroom.lastFreeMb !== null && volume.freeMb <= headroom.lastFreeMb) headroom.helpless = true;
  headroom.acted = false;
  headroom.lastFreeMb = volume.freeMb;
  if (volume.freeMb >= headroom.freeMb || headroom.helpless) return NORMAL_PRESSURE;
  return {
    ...NORMAL_PRESSURE,
    level: 'high',
    disk: 'high',
    reasons: [
      `${(volume.freeMb / 1024).toFixed(1)} GB free on ${volume.volume}, under the ${(headroom.freeMb / 1024).toFixed(1)} GB the next build needs`,
    ],
  };
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
 * once the level clears: the idle stage (for every workspace idle 2 minutes or more while the measured memory level is
 * above normal, else at `idle.minutes`), then rungs 1 to 8 (rungs 5 and 8 only at critical). `stim gc` runs one
 * level with `act`; `stim gc --dry-run` previews it, measuring what each action would free. Logs to `daemon.ndjson`
 * under `trigger` when acting. Null without a Stim config.
 */
export async function runForcedLadder({
  levels,
  act,
  why,
  trigger,
  operation,
  protectedRoot,
  measured: atMeasuredLevel = false,
}: {
  levels: readonly ('high' | 'critical')[];
  act: boolean;
  why: string;
  trigger: string;
  operation?: StimContext;
  /** The workspace of the command that runs the ladder, which no rung takes. */
  protectedRoot?: string;
  /** The level is the one the machine measured, not one the caller chose, so rung 9 measures again before it acts. */
  measured?: boolean;
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
    const volumes =
      atMeasuredLevel && pressure.memory === 'normal'
        ? shortVolumeDevices(measured.measurement.disk, thresholds, 'high')
        : undefined;
    const result: ForcedLadder['levels'] = [];
    for (const level of levels) {
      const actions: DaemonLadderAction[] = [];
      for (const entry of await runIdlePass({
        ...reading,
        act,
        // @ref LLP 0001#the-2-minute-idle-stop-is-for-memory -- a stop frees memory, not disk
        ...(pressure.memory === 'normal'
          ? { disk: volumes ? { volumes } : {} }
          : { pressure: { level, reasons: [why] } }),
      })) {
        if (entry.outcome !== 'idle' && entry.outcome !== 'would-idle' && entry.outcome !== 'failed') continue;
        actions.push({
          rung: 1,
          kind: 'idle-stage',
          target: entry.path,
          workspace: entry.path,
          outcome: entry.outcome === 'idle' ? 'done' : entry.outcome === 'would-idle' ? 'would' : 'failed',
          bytes:
            entry.freedBytes ??
            (entry.outcome === 'would-idle'
              ? await idleOutputBytes(
                  entry.path,
                  config,
                  launchingOf(
                    await checkoutRootOf(entry.path, operation?.signal, operation),
                    launchersOf(operation, operation?.signal, false),
                    operation,
                    operation?.signal,
                  ),
                  volumes && onDiskVolumes(entry.path, volumes) ? (path) => onShortVolume([path], volumes) : undefined,
                )
              : 0),
          detail: entry.outcome === 'would-idle' ? 'stim gc would do this' : entry.detail,
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
          force: { level, why, measured: atMeasuredLevel },
          measure: !act,
          operation,
          ...(protectedRoot ? { protectedRoot } : {}),
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
 * What `stim gc` runs at every level for each workspace with no activity for `idle.dormantDays`: the dormant stage (its
 * owned devices deleted, its logs archived), then the dormant step the daemon runs hourly: its regenerable build
 * outputs, then the node_modules and Pods of linked worktrees. Logs to `daemon.ndjson` under `trigger` when acting. Empty without a Stim config or
 * with the stage off.
 */
export async function runDormantReduction({
  act,
  trigger,
  operation,
  protectedRoot,
  walkUnknown,
}: {
  act: boolean;
  trigger: string;
  operation?: StimContext;
  protectedRoot?: string;
  walkUnknown?: false;
}): Promise<DaemonLadderAction[]> {
  const config = loadConfig();
  const afterMs = dormantAfterMs(config);
  if (!config || (afterMs <= 0 && sourceDormantAfterMs(config) <= 0)) return [];
  const measured = await measureTick(config, Date.now(), {
    probe: act,
    signal: operation?.signal,
    operation,
  });
  const writer = act ? createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES }) : null;
  const log: IdlePassInput['log'] = (logLevel, event, msg, fields = {}) =>
    writer?.write({ src: trigger, level: logLevel, event, msg, ...fields });
  const reading = {
    devices: measured.devices,
    simsFailed: measured.sims === null,
    operation,
    ...(protectedRoot ? { protectedRoot } : {}),
  };
  try {
    const actions: DaemonLadderAction[] = [];
    if (afterMs > 0) actions.push(...(await runDormantPass({ config, act, log, ...reading })));
    actions.push(
      ...(await runDormantDependencies({
        config,
        act,
        log,
        ...reading,
        force: true,
        ...(walkUnknown === false ? { walkUnknown } : {}),
      })),
    );
    return actions;
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

const HEADROOM_DEADLINE_MS = 60_000;

/**
 * Runs the pressure ladder for a build once, in this process, until the volume with device id `device` has `freeMb`
 * free or the rungs are spent, at the high level (rungs 2 to 8, never rung 9) whatever that target is relative to
 * `disk.minFreeGb`; other volumes and memory do not count. It asks the daemon for nothing and returns at once when a
 * stimd of another build refused this process or another process holds the `ladderRunClaims` claim. It stops after
 * 60 seconds: the deadline and `signal` are checked at every re-measurement, which each rung makes before every
 * action, so a step in flight finishes and no step is left half done. Throws only when `signal` aborts.
 */
export async function runLadderToFree({
  operation,
  signal,
  device,
  freeMb,
  protectedRoot,
}: {
  operation: StimContext;
  signal: AbortSignal;
  device: number;
  freeMb: number;
  protectedRoot: string;
}): Promise<void> {
  if (stimdRefused()) return;
  let claim: ClaimHandle | null = null;
  try {
    const attempt = tryAcquireClaim({ root: ladderRunClaims(), mode: 'exclusive', label: 'pressure ladder' });
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired ?? null;
  } catch {
    return;
  }
  if (!claim) return;
  const stop = AbortSignal.any([signal, AbortSignal.timeout(HEADROOM_DEADLINE_MS)]);
  try {
    await runCommandLadder('command', operation.env, protectedRoot, {
      device,
      freeMb,
      operation,
      stop,
      acted: false,
      lastFreeMb: null,
      helpless: false,
    });
  } catch {
    signal.throwIfAborted();
  } finally {
    releaseClaim(claim);
  }
}
