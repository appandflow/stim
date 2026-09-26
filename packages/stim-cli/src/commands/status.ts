import { deviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import {
  createRefreshScheduler,
  WATCH_DEBOUNCE_MS,
  WATCH_FALLBACK_MS,
  WATCH_LIGHT_INTERVAL_MS,
  watchStatusSources,
} from '../status-watch.ts';
import type { StatusSources } from '../status-watch.ts';
import chalk from 'chalk';
import { existsSync, fstatSync } from 'fs';
import { homedir, totalmem } from 'os';
import { basename, dirname } from 'path';
import type { Command } from 'commander';
import { getConfigDir, loadConfig } from '../workspace/config.ts';
import type { ProjectRecord, SupervisorRecord } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import { listeningPids, listeningPidsByPort, processCwd, processCwds, resolveProjectMetro } from '../metro.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { describeMetroLastStop, metroLastStop } from '../supervisor/stop-cause.ts';
import type { MetroResolution } from '../metro.ts';
import { countErrorsSinceMarker } from '../diagnostics/error-index.ts';
import { workspaceLogErrorIndex, workspaceLogsDir } from '../workspace/paths.ts';
import { readSupervisorState } from './stop.ts';
import { detectIsExpo, findServerWorkspace, projectShortcut } from '../workspace/project.ts';
import { listAllIosSimsAsync, parseSimctlList } from '../devices/ios.ts';
import { ownedAvdDeviceProfile, ownedAvdSerialResolver, type ResolvedAvdSerial } from '../devices/android.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { gitCommonDir, gitCommonDirOnDisk, linkedWorktreesOnDisk, repoRoot } from '../workspace/worktree.ts';
import { inPrivacyProtectedFolder, readWorktreeGit } from '../workspace/git-summary.ts';
import { readWorkspaceState, type WorkspaceState } from '../workspace/workspace-state.ts';
import { readStats, statsProjectKey, type RunHistory } from '../engine/stats.ts';
import {
  ACTIVE_BUILD_KEY,
  activeBuildState,
  buildReport,
  buildStatusLine,
  parseActiveBuild,
  type BuildReport,
} from '../engine/build-progress.ts';
import { volumeRootFor } from '../fs-util.ts';
import { formatDuration } from '../command-output.ts';
import { listLeaseFiles } from '../engine/device-lease.ts';
import { readEasSessionLedger } from '../engine/eas-session-ledger.ts';
import { readRemoteSession, readWorkspaceLaunches } from '../supervisor/state.ts';
import {
  readIdleStop,
  readBuildHistory,
  readLastBuilds,
  withStateReadCache,
  type DeviceAppProcess,
  type LastBuildReport,
  type MachineUsageState,
  type StatusPayload,
} from '@stim-cli/core/state';
import {
  createActivityReader,
  createDeviceProcessTables,
  type ActivityTarget,
  type DeviceActivity,
  type DeviceProcessTables,
} from '../devices/activity.ts';
import { createAppProcessReader } from '../devices/app-process.ts';
import {
  activityLabel,
  capacity,
  deviceLeaseLines,
  deviceLeaseStates,
  diskLine,
  environmentState,
  gitSummaryText,
  parseDfFree,
  poolLine,
  remoteDeviceLine,
  remoteDeviceState,
  statusActivity,
  tightVolumes,
  unprovisionedWorktrees,
  withWebFacts,
} from '../status.ts';
import { readWebRecord, webFacts, type WebFacts } from '../web/state.ts';
import { attributeMachineUsage, type WorkspaceProcessRoots } from '../machine-usage.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY, readParked } from '../devices/sim-pool.ts';
import type { AndroidRuntimeFacts, EnvironmentState, VolumeInfo, WorktreeFacts } from '../status.ts';

type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

interface StatusOptions {
  json?: boolean;
  watch?: boolean;
}

const WATCH_GIT_MAX_AGE_MS = 60_000;
const WATCH_READER_CHECK_MS = 2_000;

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
      const json = Boolean(opts.json);
      for (const line of renderStatus(await readStatus(0), json)) console.log(line);
    });
}

interface StatusSnapshot {
  projects: [string, ProjectRecord][];
  states: EnvironmentState[];
  labelOnlyRoots: boolean[];
  leases: ReturnType<typeof deviceLeaseStates>;
  leaseNow: number;
  orphanWorktrees: WorktreeFacts[];
  simsAvailable: boolean;
  simctlError: string | null;
  cwdRoot: string | null;
  tables: DeviceProcessTables;
  machine: MachineUsageState | null;
  roots: WorkspaceProcessRoots[];
  simNames: Record<string, string>;
}

function readStatus(gitMaxAgeMs: number, simctlListing: string | null = null): Promise<StatusSnapshot> {
  return withStateReadCache(() => readStatusFacts(gitMaxAgeMs, simctlListing));
}

async function readStatusFacts(gitMaxAgeMs: number, simctlListing: string | null): Promise<StatusSnapshot> {
  const cfg = loadConfig();
  const projects = Object.entries(cfg?.projects || {});
  const cwdRoot = findServerWorkspace(process.cwd())?.root ?? null;
  const worktrees = linkedWorktrees([process.cwd(), ...projects.map(([path]) => path)]);
  const orphanWorktrees = unprovisionedWorktrees(
    worktrees,
    projects.map(([p]) => p),
  );

  const simsRead =
    simctlListing === null ? listAllIosSimsAsync() : Promise.resolve().then(() => parseSimctlList(simctlListing));
  simsRead.catch(() => {});
  const ports = await portLookup(projects.flatMap(([, proj]) => (proj.metroPort ? [proj.metroPort] : [])));
  const processes = Promise.all(
    projects.map(async ([path, proj]) => {
      const metro = proj.metroPort ? await resolveOnPort(proj.metroPort, path, ports) : null;
      return { metro, supervisor: await supervisorFacts(path, proj, metro, ports) };
    }),
  );
  processes.catch(() => {});
  const gitRead = readGitInto(worktrees, orphanWorktrees, gitMaxAgeMs);

  const androidRuntimeOf = androidRuntimeReader();
  const devices = projects.map(([, proj]) => ({
    androidRuntimes: Object.fromEntries(
      projectDeviceSlots(proj)
        .slice(1)
        .map(({ slot, platforms }) => [
          slot,
          platforms.android?.owned && platforms.android.avdName ? androidRuntimeOf(platforms.android.avdName) : null,
        ]),
    ),
    androidRuntime:
      proj.platforms?.android?.owned && proj.platforms.android.avdName
        ? androidRuntimeOf(proj.platforms.android.avdName)
        : null,
    androidDeviceProfiles: Object.fromEntries(
      projectDeviceSlots(proj)
        .slice(1)
        .map(({ slot, platforms }) => [
          slot,
          platforms.android?.owned && platforms.android.avdName
            ? ownedAvdDeviceProfile(platforms.android.avdName)
            : null,
        ]),
    ),
    androidDeviceProfile:
      proj.platforms?.android?.owned && proj.platforms.android.avdName
        ? ownedAvdDeviceProfile(proj.platforms.android.avdName)
        : null,
  }));
  const logs = projects.map(([path]) => logFacts(path));

  const simsByUdid: Record<string, IosSimRecord> = {};
  let simsAvailable = true;
  let simctlError: string | null = null;
  try {
    for (const sim of await simsRead) simsByUdid[sim.udid] = sim;
  } catch (e) {
    simsAvailable = false;
    simctlError = String((e as Error)?.message || e).split('\n')[0] ?? '';
  }
  const running = await processes;
  await gitRead;

  const history = readStats().record?.history;
  const states: EnvironmentState[] = [];
  const labelOnlyRoots: boolean[] = [];
  const launchesByState: ReturnType<typeof readWorkspaceLaunches>[] = [];
  const easLedger = readEasSessionLedger();
  const leaseNow = Date.now();
  const leaseFiles = listLeaseFiles();
  const leases = deviceLeaseStates(leaseFiles, { root: cwdRoot, now: leaseNow });
  const roots: WorkspaceProcessRoots[] = [];
  for (const [i, [path, proj]] of projects.entries()) {
    const { metro, supervisor } = running[i]!;
    const saved = readWorkspaceState(path);
    const builds = workspaceBuilds(path, saved, history);
    const web = webFacts(readWebRecord(path));
    const activeBuild = parseActiveBuild(saved?.[ACTIVE_BUILD_KEY]);
    roots.push({
      path,
      supervisorPid: supervisor?.status === 'ours' ? supervisor.pid : null,
      build:
        activeBuild && builds.build?.state === 'running'
          ? { platform: activeBuild.platform, pid: activeBuild.claim.pid }
          : null,
      browserPids: browserPids(web),
    });
    const launches = readWorkspaceLaunches(path);
    launchesByState.push(launches);
    states.push(
      withWebFacts(
        environmentState(
          { ...proj, __path: path },
          {
            simsByUdid,
            metro,
            worktrees,
            simsAvailable,
            ...devices[i],
            supervisor,
            logs: logs[i],
            remote: remoteDeviceState(readRemoteSession(path), easLedger, path),
            idleStop: readIdleStop(saved),
            lastStop: metroLastStop(saved, supervisor),
            launches,
            leasedIds: new Set(
              deviceLeaseStates(leaseFiles, { root: path, now: leaseNow }).flatMap((lease) =>
                lease.mine && !lease.expired && lease.id ? [lease.id] : [],
              ),
            ),
            now: leaseNow,
          },
        ),
        web,
      ),
    );
    const state = states[states.length - 1];
    if (state) Object.assign(state, builds);
    labelOnlyRoots.push(
      Boolean(proj.worktreeRoot && !proj.bundleId && !state?.metro && !state?.ios && !state?.android && !state?.web),
    );
  }

  const tables = createDeviceProcessTables();
  readDeviceProcesses(states, tables, { projects, launchesByState });
  const sims = Object.values(simsByUdid);
  const simNames = Object.fromEntries(sims.map((sim) => [sim.udid.toUpperCase(), sim.name]));
  const busy = sims.some((sim) => sim.state === 'Booted');
  const machine = readMachineUsage({ states, roots, simNames, tables, busy });
  return {
    projects,
    states,
    labelOnlyRoots,
    leases,
    leaseNow,
    orphanWorktrees,
    simsAvailable,
    simctlError,
    cwdRoot,
    tables,
    machine,
    roots,
    simNames,
  };
}

function browserPids(web: WebFacts | null): number[] {
  if (!web) return [];
  const chrome = web.record.chromeProcess?.pid;
  if (web.status === 'running') return [web.record.pid, ...(chrome ? [chrome] : [])];
  return web.status === 'orphaned' && chrome ? [chrome] : [];
}

/**
 * Attributes the host process table to its owners. Reads the table only when a simulator is booted, a workspace is
 * live or a build runs, so an idle machine runs no `ps`.
 */
function readMachineUsage({
  states,
  roots,
  simNames,
  tables,
  busy,
}: {
  states: EnvironmentState[];
  roots: WorkspaceProcessRoots[];
  simNames: Record<string, string>;
  tables: DeviceProcessTables;
  busy: boolean;
}): MachineUsageState | null {
  const needed = busy || states.some((state) => state.live || state.build?.state === 'running');
  const processes = needed ? tables.host() : null;
  return processes ? attributeMachineUsage({ processes, environments: states, roots, simNames }) : null;
}

/**
 * Rereads only the error counts, device activity and machine usage. With `machine`, and when the snapshot measured
 * machine usage, it reads the host process table again; it reuses every other subprocess fact of the full read.
 */
function refreshLightFacts(snapshot: StatusSnapshot, machine: boolean): void {
  if (machine && snapshot.machine) {
    const fresh = createDeviceProcessTables();
    snapshot.tables = { host: fresh.host, android: snapshot.tables.android };
  }
  withStateReadCache(() => {
    for (const state of snapshot.states) state.logs = logFacts(state.path);
    readDeviceProcesses(snapshot.states, snapshot.tables, null);
  });
  if (machine && snapshot.machine) {
    snapshot.machine = readMachineUsage({ ...snapshot, busy: true });
  }
}

function renderStatus(
  {
    projects,
    states,
    labelOnlyRoots,
    leases,
    leaseNow,
    orphanWorktrees,
    simsAvailable,
    simctlError,
    cwdRoot,
    machine,
  }: StatusSnapshot,
  json: boolean,
): string[] {
  const out: string[] = [];
  const totalMemoryMb = Math.round(totalmem() / (1024 * 1024));
  const cap = capacity(states, totalMemoryMb);
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
        machine,
      } satisfies StatusPayload),
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
        : chalk.dim(`  app: ${proj.bundleId ?? '?'} (${(proj.isExpo ?? detectIsExpo(path)) ? 'expo' : 'bare'})`),
    );

    if (state.metro) {
      const label = state.metro.running
        ? chalk.green(`running (pid ${state.metro.pid})`)
        : state.metro.idleStop
          ? chalk.dim(
              `stopped (idle) after ${state.metro.idleStop.idleMinutes}m; \`stim start\`, \`ios\` or \`android\` restarts it`,
            )
          : state.metro.lastStop
            ? chalk.dim(
                `not running${state.metro.lastStop.reason === 'vanished' ? '' : ` since ${state.metro.lastStop.at}`}; ${describeMetroLastStop(state.metro.lastStop)}`,
              )
            : chalk.dim('not running');
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
    out.push(...lastBuildsLines(state.lastBuilds));
    if (state.worktree?.git) out.push(chalk.dim(`  git: ${gitSummaryText(state.worktree.git)}`));
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
        out.push(
          `  ios${slotLabel}: ${chalk.cyan(deviceState.ios.name ?? deviceState.ios.udid)} ${booted}${owned}${activitySuffix(deviceState.ios.activity)}${appSuffix(deviceState.ios.app)}`,
        );
      }
      if (deviceState.android) {
        const kind = deviceState.android.physical ? chalk.dim('(physical)') : chalk.dim('(emulator)');
        const observed = deviceState.android.state
          ? ` ${deviceState.android.state}${deviceState.android.serial ? ` (${deviceState.android.serial})` : ''}`
          : '';
        out.push(
          `  android${slotLabel}: ${chalk.cyan(deviceState.android.name)} ${kind}${observed}${deviceState.android.owned ? chalk.dim(' (owned)') : ''}${activitySuffix(deviceState.android.activity)}${appSuffix(deviceState.android.app)}`,
        );
      }
    }
    if (state.web) {
      const browser = state.web.running
        ? chalk.green(`running (pid ${state.web.pid}, DevTools ${state.web.cdpEndpoint})`)
        : chalk.dim('not running');
      out.push(`  web: ${chalk.cyan(state.web.url)} ${browser}${state.web.headless ? '' : chalk.dim(' (headed)')}`);
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
    for (const w of orphanWorktrees) out.push(chalk.dim(`  ${orphanWorktreeLine(w)}`));
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
  let snapshot: StatusSnapshot | null = null;
  let sources: StatusSources | null = null;
  const scheduler = createRefreshScheduler({
    debounceMs: WATCH_DEBOUNCE_MS,
    lightIntervalMs: WATCH_LIGHT_INTERVAL_MS,
    run: async (kind) => {
      let text: string;
      try {
        if (kind === 'light' && snapshot) refreshLightFacts(snapshot, json);
        else snapshot = await readStatus(WATCH_GIT_MAX_AGE_MS, sources?.simulatorListing());
        text = renderStatus(snapshot, json).join('\n');
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
  const fallback = setInterval(() => scheduler.trigger('full'), WATCH_FALLBACK_MS);
  const machine = setInterval(() => json && snapshot?.machine && scheduler.trigger('light'), WATCH_LIGHT_INTERVAL_MS);
  const parent = process.ppid;
  const stdout = fstatSync(1);
  const piped = process.platform !== 'win32' && (stdout.isFIFO() || stdout.isSocket());
  // macOS fails a zero-length write to a pipe or socket whose reader is gone with EPIPE; Linux
  // returns 0 without checking the reader, so there only the parent's exit is detectable.
  const reader = setInterval(() => {
    if (piped && process.ppid !== parent) finish();
    else process.stdout.write('');
  }, WATCH_READER_CHECK_MS);
  const finish = () => {
    clearInterval(fallback);
    clearInterval(machine);
    clearInterval(reader);
    scheduler.stop();
    sources?.stop();
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  process.stdout.on('error', finish);
  sources = watchStatusSources({ home: getConfigDir(), onChange: (kind) => scheduler.trigger(kind) });
  scheduler.trigger('full', 0);
  await new Promise<never>(() => {});
}

async function readGitInto(worktrees: WorktreeFacts[], orphans: WorktreeFacts[], maxAgeMs: number): Promise<void> {
  const home = homedir();
  const byPath = await readWorktreeGit(worktrees, {
    maxAgeMs,
    skip: (w) => process.platform === 'darwin' && orphans.includes(w) && inPrivacyProtectedFolder(w.path, home),
  });
  for (const worktree of worktrees) worktree.git = byPath.get(worktree.path) ?? null;
}

function orphanWorktreeLine(w: WorktreeFacts): string {
  return `${w.path}${w.branch ? ` [${w.branch}]` : ''}${w.git ? ` -- ${gitSummaryText(w.git)}` : ''}`;
}

function lastBuildsLines(reports: EnvironmentState['lastBuilds']): string[] {
  const texts = Object.values(reports ?? {}).map(lastBuildText);
  return texts.length ? [chalk.dim(`  last build: ${texts.join(', ')}`)] : [];
}

function lastBuildText(report: LastBuildReport): string {
  const source = report.cacheHit ? `${report.cacheHit} cache` : report.status === 'ok' ? 'compiled' : 'no cache hit';
  const took = report.durationMs === null ? '' : ` in ${formatDuration(report.durationMs)}`;
  return `${report.platform} ${report.status === 'ok' ? source : `failed (${report.errorCode ?? 'error'}), ${source}`}${took}`;
}

function activitySuffix(activity: DeviceActivity | undefined): string {
  const label = activityLabel(activity, Date.now());
  return label ? ` -- ${activity?.state === 'driven' ? chalk.magenta(label) : chalk.dim(label)}` : '';
}

function readDeviceProcesses(
  states: EnvironmentState[],
  tables: DeviceProcessTables,
  apps: { projects: [string, ProjectRecord][]; launchesByState: ReturnType<typeof readWorkspaceLaunches>[] } | null,
): void {
  const readActivity = createActivityReader({ tables });
  const readAppProcess = createAppProcessReader(tables);
  for (const [i, state] of states.entries()) {
    const appIdOn = (platform: 'ios' | 'android', slot: string, deviceId: string) => {
      if (!apps) return undefined;
      const project = apps.projects[i]![1];
      const launch = apps.launchesByState[i]![deviceSlotKey(platform, slot)];
      return launch?.deviceId === deviceId
        ? launch.appId
        : platform === 'ios'
          ? project.bundleId
          : project.androidPackage;
    };
    for (const device of [{ slot: 'default', ios: state.ios, android: state.android }, ...(state.slots ?? [])]) {
      const base: Omit<ActivityTarget, 'platform' | 'id'> = { slot: device.slot, workspace: state.path };
      if (device.ios?.state === 'Booted') {
        const id = device.ios.udid;
        device.ios.activity = statusActivity(readActivity({ ...base, platform: 'ios', id }));
        const appId = device.ios.owned ? appIdOn('ios', device.slot, id) : undefined;
        if (appId) device.ios.app = readAppProcess({ platform: 'ios', id, appId });
      }
      if (device.android && !device.android.physical && device.android.serial) {
        const id = device.android.serial;
        device.android.activity = statusActivity(readActivity({ ...base, platform: 'android', id }));
        const appId = device.android.owned ? appIdOn('android', device.slot, id) : undefined;
        if (appId) device.android.app = readAppProcess({ platform: 'android', id, appId });
      }
    }
  }
}

function appSuffix(app: DeviceAppProcess | undefined): string {
  if (!app) return '';
  if (app.state === 'running') return chalk.dim(` -- ${app.id} running`);
  if (app.state === 'stopped') return ` -- ${chalk.yellow(`${app.id} not running`)}`;
  return chalk.dim(` -- ${app.id} process unknown`);
}

function linkedWorktrees(paths: string[]): WorktreeFacts[] {
  const commonDirs = new Set(paths.flatMap((path) => gitCommonDirOnDisk(path) ?? []));
  return [...commonDirs].flatMap((common) => {
    const repository = basename(common) === '.git' ? dirname(common) : common;
    return linkedWorktreesOnDisk(common).map((entry) => Object.assign(entry, { repository }));
  });
}

function workspaceBuilds(
  path: string,
  saved: WorkspaceState | null,
  history: Record<string, RunHistory> | undefined,
): Pick<EnvironmentState, 'build' | 'lastBuilds' | 'builds'> {
  const lastBuilds = readLastBuilds(saved);
  const builds = readBuildHistory(saved);
  return {
    build: workspaceBuild(path, saved, history),
    ...(lastBuilds.ios || lastBuilds.android ? { lastBuilds } : {}),
    ...(builds.ios || builds.android ? { builds } : {}),
  };
}

function workspaceBuild(
  path: string,
  saved: WorkspaceState | null,
  history: Record<string, RunHistory> | undefined,
): BuildReport | null {
  const record = parseActiveBuild(saved?.[ACTIVE_BUILD_KEY]);
  if (!record) return null;
  const projectKey = statsProjectKey({ root: path, commonDir: gitCommonDir(path), repoRoot: repoRoot(path) });
  return buildReport(record, { state: activeBuildState(record.claim), history: history?.[projectKey] });
}

function androidRuntimeReader(): (avdName: string) => AndroidRuntimeFacts {
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return (avdName) => readAndroidRuntime(() => resolve(avdName));
}

function readAndroidRuntime(resolveSerial: () => ResolvedAvdSerial): AndroidRuntimeFacts {
  try {
    const resolved = resolveSerial();
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

interface PortLookup {
  answering: Map<number, boolean>;
  pidsOf: (port: number) => Promise<number[]>;
  cwdOf: (pid: number) => Promise<string | null>;
}

async function portLookup(metroPorts: number[]): Promise<PortLookup> {
  const ports = [...new Set(metroPorts)];
  const answering = new Map(await Promise.all(ports.map(async (port) => [port, await isMetroRunning(port)] as const)));
  const listeners = listeningPidsByPort(ports.filter((port) => answering.get(port)));
  const cwds = listeners.then((byPort) => processCwds([...byPort.values()].flatMap((pids) => pids.slice(0, 1))));
  return {
    answering,
    pidsOf: async (port) => (await listeners).get(port) ?? listeningPids(port),
    cwdOf: async (pid) => {
      const known = await cwds;
      return known.has(pid) ? (known.get(pid) ?? null) : processCwd(pid);
    },
  };
}

async function resolveOnPort(port: number, path: string, lookup: PortLookup): Promise<MetroResolution> {
  const running = lookup.answering.get(port) ?? (await isMetroRunning(port));
  return running ? resolveProjectMetro(port, path, lookup) : { missing: true };
}

interface SupervisorFacts {
  pid: number;
  mode: string | null;
  startedAt: string | null;
  status: 'ours' | 'stale' | 'unverified';
  reason?: string;
  healthy: boolean;
}

async function supervisorFacts(
  path: string,
  proj: ProjectRecord | undefined,
  metroResolution: MetroResolution | null,
  lookup: PortLookup,
): Promise<SupervisorFacts | null> {
  const state = readSupervisorState(path);
  const record: SupervisorRecordExt | null = proj?.supervisor ?? null;
  const pid = state?.pid ?? record?.pid ?? null;
  if (!pid) return null;
  const port = state?.port ?? record?.port ?? null;
  const target = resolveSupervisorTarget({ state, record, reservedPort: proj?.metroPort });
  const status = target.status === 'ours' ? 'ours' : target.status === 'unverified' ? 'unverified' : 'stale';
  let healthy = false;
  if (status === 'ours' && port) {
    const resolution =
      port === proj?.metroPort && metroResolution ? metroResolution : await resolveOnPort(port, path, lookup);
    healthy = Boolean(resolution?.metro);
  }
  return {
    pid,
    mode: state?.mode ?? record?.mode ?? null,
    startedAt: state?.startedAt ?? record?.startedAt ?? null,
    status,
    ...(target.reason ? { reason: target.reason } : {}),
    healthy,
  };
}

function logFacts(path: string): { dir: string; errorsSinceMarker: number } | null {
  const dir = workspaceLogsDir(path);
  if (!existsSync(dir)) return null;
  try {
    return { dir, errorsSinceMarker: countErrorsSinceMarker(dir, workspaceLogErrorIndex(path)) };
  } catch {
    return { dir, errorsSinceMarker: 0 };
  }
}
