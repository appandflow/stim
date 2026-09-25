import { projectDeviceSlots } from '../devices/device-slots.ts';
import { createRefreshScheduler, WATCH_DEBOUNCE_MS, WATCH_FALLBACK_MS, watchStatusSources } from '../status-watch.ts';
import type { StatusSources } from '../status-watch.ts';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { totalmem } from 'os';
import type { Command } from 'commander';
import { getConfigDir, loadConfig } from '../workspace/config.ts';
import type { ProjectRecord, SupervisorRecord } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import { resolveProjectMetro } from '../metro.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import type { MetroResolution } from '../metro.ts';
import { queryLogs } from '../diagnostics/logs-query.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readSupervisorState } from './stop.ts';
import { findProjectRoot, projectShortcut } from '../workspace/project.ts';
import { listAllIosSims } from '../devices/ios.ts';
import { resolveOwnedAvdSerial } from '../devices/android.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { gitCommonDir, repoRoot, resolveSourceCheckout } from '../workspace/worktree.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { readStats, statsProjectKey, type RunHistory } from '../engine/stats.ts';
import {
  ACTIVE_BUILD_KEY,
  activeBuildState,
  buildReport,
  buildStatusLine,
  parseActiveBuild,
  type BuildReport,
} from '../engine/build-progress.ts';
import type { WorktreeEntry } from '../workspace/worktree.ts';
import { volumeRootFor } from '../fs-util.ts';
import { listLeaseFiles } from '../engine/device-lease.ts';
import { readEasSessionLedger } from '../engine/eas-session-ledger.ts';
import { readRemoteSession } from '../supervisor/state.ts';
import {
  capacity,
  deviceLeaseLines,
  deviceLeaseStates,
  diskLine,
  environmentState,
  parseDfFree,
  poolLine,
  remoteDeviceLine,
  remoteDeviceState,
  tightVolumes,
  unprovisionedWorktrees,
} from '../status.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY, readParked } from '../devices/sim-pool.ts';
import type { AndroidRuntimeFacts, EnvironmentState, VolumeInfo } from '../status.ts';

type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

interface StatusOptions {
  json?: boolean;
  watch?: boolean;
}

function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function statusCommand(program: Command): void {
  program
    .command('status')
    .description(
      'Show every environment on this machine: devices, ports, what is actually running, and anything stuck.',
    )
    .option('--json', 'print the state as JSON')
    .option('--watch', 'keep running and print the state again each time it changes')
    .action(async (opts: StatusOptions) => {
      if (opts.watch) return watchStatus(Boolean(opts.json));
      for (const line of await statusLines(Boolean(opts.json))) console.log(line);
    });
}

async function statusLines(json: boolean): Promise<string[]> {
  const out: string[] = [];
  const cfg = loadConfig();
  const projects = Object.entries(cfg?.projects || {});
  const cwdRoot = findProjectRoot(process.cwd());

  const simsByUdid: Record<string, IosSimRecord> = {};
  let simsAvailable = true;
  let simctlError: string | null = null;
  try {
    for (const sim of listAllIosSims()) simsByUdid[sim.udid] = sim;
  } catch (e) {
    simsAvailable = false;
    simctlError = String((e as Error)?.message || e).split('\n')[0] ?? '';
  }

  const source = resolveSourceCheckout(process.cwd());
  const sourcePath = 'path' in source ? source.path : null;
  const worktrees: WorktreeEntry[] = source.entries.filter((entry) => !entry.bare && entry.path !== sourcePath);

  const history = readStats().record?.history;
  const states: EnvironmentState[] = [];
  const labelOnlyRoots: boolean[] = [];
  const easLedger = readEasSessionLedger();
  for (const [path, proj] of projects) {
    let metro: MetroResolution | null = null;
    if (proj.metroPort) {
      metro = await resolveOnPort(proj.metroPort, path);
    }
    const supervisor = await supervisorFacts(path, proj, metro);
    states.push(
      environmentState(
        { ...proj, __path: path },
        {
          simsByUdid,
          metro,
          worktrees,
          simsAvailable,
          androidRuntimes: Object.fromEntries(
            projectDeviceSlots(proj)
              .slice(1)
              .map(({ slot, platforms }) => [
                slot,
                platforms.android?.owned && platforms.android.avdName
                  ? readAndroidRuntime(platforms.android.avdName)
                  : null,
              ]),
          ),
          androidRuntime:
            proj.platforms?.android?.owned && proj.platforms.android.avdName
              ? readAndroidRuntime(proj.platforms.android.avdName)
              : null,
          supervisor,
          logs: logFacts(path),
          remote: remoteDeviceState(readRemoteSession(path), easLedger, path),
        },
      ),
    );
    const state = states[states.length - 1];
    if (state) state.build = workspaceBuild(path, history);
    labelOnlyRoots.push(
      Boolean(proj.worktreeRoot && !proj.bundleId && !state?.metro && !state?.ios && !state?.android),
    );
  }

  const leaseNow = Date.now();
  const leases = deviceLeaseStates(listLeaseFiles(), { root: cwdRoot, now: leaseNow });

  const totalMemoryMb = Math.round(totalmem() / (1024 * 1024));
  const cap = capacity(states, totalMemoryMb);
  const orphanWorktrees = unprovisionedWorktrees(
    worktrees,
    projects.map(([p]) => p),
  );
  const pools = (['ios', 'android'] as const).map((platform) => {
    const { max, error } = parkedMaxSetting(platform);
    return { error, line: poolLine({ platform, parked: readParked(platform).length, max }) };
  });

  if (json) {
    out.push(
      JSON.stringify({
        environments: states.map((state, i) => (labelOnlyRoots[i] ? { ...state, labelOnly: true } : state)),
        capacity: cap,
        deviceLeases: leases,
        unprovisionedWorktrees: orphanWorktrees,
        simctlAvailable: simsAvailable,
      }),
    );
    return out;
  }

  if (projects.length === 0 && orphanWorktrees.length === 0) {
    out.push(chalk.dim('No projects registered.'));
    for (const pool of pools) {
      if (pool.error) out.push(chalk.yellow(`${pool.error} ${POOL_SETTING_REMEDY}`));
      if (pool.line) out.push(chalk.dim(pool.line));
    }
    for (const line of deviceLeaseLines(leases, leaseNow)) out.push(line);
    return out;
  }

  if (!simsAvailable) {
    out.push(chalk.yellow(`simctl could not be read (${simctlError}), so no iOS sim below could be checked.`));
  }

  for (const [i, [path, proj]] of projects.entries()) {
    const state = states[i];
    if (!state) continue;
    const shortcut = projectShortcut(path, proj);
    const marker = path === cwdRoot ? chalk.bold.cyan(`* ${shortcut}`) : shortcut;
    const idle = state.live ? '' : chalk.dim(' [idle]');
    out.push(`\n${marker}${idle} ${chalk.dim(`(${path})`)}`);
    out.push(
      labelOnlyRoots[i]
        ? chalk.dim('  worktree root (holds the label; the app registers its own entry)')
        : chalk.dim(`  app: ${proj.bundleId ?? '?'} (${proj.isExpo ? 'expo' : 'bare'})`),
    );

    if (state.metro) {
      const label = state.metro.running ? chalk.green(`running (pid ${state.metro.pid})`) : chalk.dim('not running');
      out.push(`  metro: port ${state.metro.port} ${label}`);
    }
    if (state.supervisor) {
      const health = state.supervisor.healthy ? chalk.green('healthy') : chalk.yellow('not answering');
      const mode = state.supervisor.mode ? chalk.dim(` (${state.supervisor.mode})`) : '';
      out.push(`  supervisor: pid ${state.supervisor.pid}${mode} ${health}`);
    }
    if (state.build) {
      const line = `  ${buildStatusLine(state.build, Date.now())}`;
      out.push(state.build.state === 'running' ? line : chalk.yellow(line));
    }
    if (state.logs) {
      const n = state.logs.errorsSinceMarker;
      const errs = n > 0 ? chalk.yellow(` (${n} error${n === 1 ? '' : 's'} since the last marker)`) : '';
      out.push(chalk.dim(`  logs: ${state.logs.dir}`) + errs);
    }
    for (const deviceState of [{ slot: 'default', ios: state.ios, android: state.android }, ...(state.slots ?? [])]) {
      const slotLabel = deviceState.slot === 'default' ? '' : ` [${deviceState.slot}]`;
      if (deviceState.ios) {
        const booted =
          deviceState.ios.state === 'Booted' ? chalk.green('booted') : chalk.dim(deviceState.ios.state.toLowerCase());
        const owned = deviceState.ios.owned ? chalk.dim(' (owned)') : '';
        out.push(`  ios${slotLabel}: ${chalk.cyan(deviceState.ios.name ?? deviceState.ios.udid)} ${booted}${owned}`);
      }
      if (deviceState.android) {
        const kind = deviceState.android.physical ? chalk.dim('(physical)') : chalk.dim('(emulator)');
        const observed = deviceState.android.state
          ? ` ${deviceState.android.state}${deviceState.android.serial ? ` (${deviceState.android.serial})` : ''}`
          : '';
        out.push(
          `  android${slotLabel}: ${chalk.cyan(deviceState.android.name)} ${kind}${observed}${deviceState.android.owned ? chalk.dim(' (owned)') : ''}`,
        );
      }
    }
    for (const remote of state.remoteDevices ?? []) out.push(`  ${remoteDeviceLine(remote)}`);
    for (const w of state.warnings) out.push(chalk.yellow(`  ! ${w}`));
  }

  for (const pool of pools) {
    if (pool.error) out.push(chalk.yellow(`\n${pool.error} ${POOL_SETTING_REMEDY}`));
    if (pool.line) out.push(chalk.dim(`\n${pool.line}`));
  }

  const leaseLines = deviceLeaseLines(leases, leaseNow);
  if (leaseLines.length) {
    out.push('');
    for (const line of leaseLines) out.push(line);
  }

  if (orphanWorktrees.length) {
    out.push(chalk.dim(`\nWorktrees with no environment (${orphanWorktrees.length}):`));
    for (const w of orphanWorktrees) out.push(chalk.dim(`  ${w.path}${w.branch ? ` [${w.branch}]` : ''}`));
  }

  out.push(
    chalk.dim(
      `\n${cap.liveCount} live environment(s), roughly ${formatGb(cap.committedMb)} of ${formatGb(cap.totalMemoryMb)} committed.`,
    ),
  );
  const volumes = readVolumes(cwdRoot || process.cwd());
  const line = diskLine(volumes);
  if (line) {
    const tight = tightVolumes(volumes);
    if (tight.length) {
      const which = tight.map((v) => v.volume).join(' and ');
      out.push(
        chalk.yellow(
          `${line} A single iOS build can exhaust ${which} -- run \`stim gc\` before starting another environment.`,
        ),
      );
    } else {
      out.push(chalk.dim(line));
    }
  }
  if (cap.overCapacity) {
    out.push(
      chalk.yellow(
        'Over comfortable capacity. A machine that swaps is slower than one working in sequence -- release one before starting another.',
      ),
    );
  }
  return out;
}

async function watchStatus(json: boolean): Promise<void> {
  let last: string | null = null;
  let sources: StatusSources | null = null;
  const scheduler = createRefreshScheduler({
    debounceMs: WATCH_DEBOUNCE_MS,
    run: async () => {
      let text: string;
      try {
        text = (await statusLines(json)).join('\n');
      } catch (error) {
        console.error(chalk.red(String((error as Error)?.message || error)));
        return;
      } finally {
        sources?.reconcile();
      }
      if (text === last) return;
      last = text;
      process.stdout.write(`${!json && process.stdout.isTTY ? '\x1b[2J\x1b[H' : ''}${text}\n`);
    },
  });
  const fallback = setInterval(() => scheduler.trigger(), WATCH_FALLBACK_MS);
  const finish = () => {
    clearInterval(fallback);
    scheduler.stop();
    sources?.stop();
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  process.stdout.on('error', finish);
  sources = watchStatusSources({ home: getConfigDir(), onChange: () => scheduler.trigger() });
  scheduler.trigger(0);
  await new Promise<never>(() => {});
}

function workspaceBuild(path: string, history: Record<string, RunHistory> | undefined): BuildReport | null {
  const record = parseActiveBuild(readWorkspaceState(path)?.[ACTIVE_BUILD_KEY]);
  if (!record) return null;
  const projectKey = statsProjectKey({ root: path, commonDir: gitCommonDir(path), repoRoot: repoRoot(path) });
  return buildReport(record, { state: activeBuildState(record.claim), history: history?.[projectKey] });
}

function readAndroidRuntime(avdName: string): AndroidRuntimeFacts {
  try {
    const resolved = resolveOwnedAvdSerial(avdName, { timeoutMs: 5000 });
    return {
      serial: resolved.serial ?? null,
      state: resolved.serial
        ? 'detected'
        : resolved.missing
          ? 'missing'
          : resolved.notRunning
            ? 'not-detected'
            : 'unknown',
    };
  } catch (error) {
    return { serial: null, state: 'unknown', error: String((error as Error)?.message || error).split('\n')[0] };
  }
}

export function readVolumes(projectPath: string): VolumeInfo[] {
  const roots = [...new Set(['/', volumeRootFor(getConfigDir()), volumeRootFor(projectPath)])];
  const volumes: VolumeInfo[] = [];
  for (const volume of roots) {
    const quoted = `'${volume.replace(/'/g, "'\\''")}'`;
    const disk = parseDfFree(getExecutor().runQuiet(`df -k ${quoted}`, { timeoutMs: 5000 }));
    if (disk) volumes.push({ volume, disk });
  }
  return volumes;
}

async function resolveOnPort(port: number, path: string): Promise<MetroResolution> {
  return (await isMetroRunning(port)) ? resolveProjectMetro(port, path) : { missing: true };
}

interface SupervisorFacts {
  pid: number;
  mode: string | null;
  startedAt: string | null;
  alive: boolean;
  healthy: boolean;
}

async function supervisorFacts(
  path: string,
  proj: ProjectRecord | undefined,
  metroResolution: MetroResolution | null,
): Promise<SupervisorFacts | null> {
  const state = readSupervisorState(path);
  const record: SupervisorRecordExt | null = proj?.supervisor ?? null;
  const pid = state?.pid ?? record?.pid ?? null;
  if (!pid) return null;
  const port = state?.port ?? record?.port ?? null;
  const alive = resolveSupervisorTarget({ state, record, reservedPort: proj?.metroPort }).status === 'ours';
  let healthy = false;
  if (alive && port) {
    const resolution = port === proj?.metroPort && metroResolution ? metroResolution : await resolveOnPort(port, path);
    healthy = Boolean(resolution?.metro);
  }
  return {
    pid,
    mode: state?.mode ?? record?.mode ?? null,
    startedAt: state?.startedAt ?? record?.startedAt ?? null,
    alive,
    healthy,
  };
}

function logFacts(path: string): { dir: string; errorsSinceMarker: number } | null {
  const dir = workspaceLogsDir(path);
  if (!existsSync(dir)) return null;
  try {
    return { dir, errorsSinceMarker: queryLogs({ dir, errorsOnly: true }).length };
  } catch {
    return { dir, errorsSinceMarker: 0 };
  }
}
