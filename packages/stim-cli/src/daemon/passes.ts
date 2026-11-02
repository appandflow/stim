import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  daemonNdjsonFile,
  type DaemonLadderAction,
  type DaemonPressure,
  type DaemonWorkspaceDecision,
} from '@stim-cli/core/state';
import { cancellableSleep } from '../cancellation.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { daemonClaimHeld, daemonMode, requestDaemonTick } from './client.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { runLadder } from './ladder.ts';
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
 * maintenance pass, in this process. The daemon runs them each tick; `stim doctor` and the disk floor gate run them
 * when no daemon holds the home. `act: false` decides and logs without acting. `memoryWarningSince` carries the
 * memory warning clock from the last tick.
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
 * The home passes in this process while no daemon holds the home, as `stim doctor` and the disk floor gate run them:
 * always on Windows, which has no daemon, and elsewhere unless `daemon.mode` is off.
 */
export async function runPassesWithoutDaemon(trigger: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    if (daemonClaimHeld() || (process.platform !== 'win32' && daemonMode(env) === 'off')) return;
    const writer = createNdjsonWriter(daemonNdjsonFile(), { maxBytes: LOG_ROTATE_BYTES });
    try {
      await runHomePasses({
        act: daemonMode(env) !== 'report',
        trigger,
        log: (level, event, msg, fields = {}) => writer.write({ src: trigger, level, event, msg, ...fields }),
      });
    } finally {
      writer.close();
    }
  } catch {}
}

const DAEMON_START_WAIT_MS = 3000;

/** Whether a daemon holds this home, waiting briefly for one the command's own start spawned. */
async function daemonHolds(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === 'win32' || daemonMode(env) === 'off') return daemonClaimHeld();
  for (let waited = 0; ; waited += 100) {
    if (daemonClaimHeld()) return true;
    if (waited >= DAEMON_START_WAIT_MS) return false;
    await cancellableSleep(100, { signal, what: 'stim-daemon' });
  }
}

/**
 * Before `start`, `ios` or `android` work: the activity and pressure passes in this process unless a daemon holds the
 * home, so Windows and a home whose daemon is not running still idle workspaces and run the ladder. True when this
 * process ran them.
 */
export async function runPassesUnlessDaemon(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  if (await daemonHolds(env, signal)) return false;
  await runPassesWithoutDaemon('command', env);
  return true;
}

/** Runs the pressure ladder now: one daemon tick when a daemon runs, else the passes in this process. */
export async function runLadderNow(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (await requestDaemonTick(env, signal)) return;
  signal?.throwIfAborted();
  await runPassesWithoutDaemon('command', env);
}
