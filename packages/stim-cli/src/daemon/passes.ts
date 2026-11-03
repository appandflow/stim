import { LOG_ROTATE_BYTES } from '@stim-cli/core';
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
import { daemonClaimHeld, daemonMode, requestDaemonTick } from './client.ts';
import { commandWorkspace } from './command-workspace.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { runLadder } from './ladder.ts';
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
 * above normal. Logs to `daemon.ndjson` under `trigger`.
 */
async function runCommandLadder(trigger: string, env: NodeJS.ProcessEnv, protectedRoot?: string): Promise<void> {
  const config = loadConfig();
  if (!config) return;
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
        act: daemonMode(env) !== 'report',
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
 * Automatic maintenance and the pressure ladder at command time, for a command that found no daemon holding the
 * home: Windows, `daemon.mode off`, or a daemon that could not start. The activity pass, idle stage included, is the
 * daemon's alone; without one, each dev server supervisor times its own idle stop. Neither pass takes
 * `protectedRoot`, the command's own workspace.
 */
export async function runPassesInProcess(
  trigger: string,
  env: NodeJS.ProcessEnv = process.env,
  protectedRoot: string | null = commandWorkspace(false, env),
): Promise<void> {
  try {
    if (env[HOME_PASSES_TEST_GUARD_ENV] || daemonClaimHeld()) return;
    await runMaintenance(trigger, { report: daemonMode(env) === 'report' });
    await runCommandLadder(trigger, env, protectedRoot ?? undefined);
  } catch {}
}
