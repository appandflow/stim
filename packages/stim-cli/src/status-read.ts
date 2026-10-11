import { readHostedAndroidStatus } from './device-host/hosted-android-status.ts';
import { readHostedIosStatus } from './device-host/hosted-ios-status.ts';
import { machineNumber } from './budget.ts';
import { readHostedMacosStatus } from './device-host/hosted-macos-status.ts';
import { inspectProcessIdentity } from './process-identity.ts';
import { deviceSlotKey, projectDeviceSlots } from './devices/device-slots.ts';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { loadConfig } from './workspace/config.ts';
import type { ProjectRecord, SupervisorRecord } from './workspace/config.ts';
import { getExecutor } from './exec.ts';
import { isMetroRunning } from './ports.ts';
import {
  listeningPids,
  listeningPidsByPort,
  pidExists,
  processCwd,
  processCwds,
  resolveProjectMetro,
} from './metro.ts';
import { resolveSupervisorTarget } from './supervisor/ownership.ts';
import { metroLastStop } from './supervisor/stop-cause.ts';
import type { MetroResolution } from './metro.ts';
import { countErrorsSinceMarker } from './diagnostics/error-index.ts';
import { workspaceLogErrorIndex, workspaceLogsDir } from './workspace/paths.ts';
import { readSupervisorState } from './commands/stop.ts';
import { detectPlatforms } from './integrations/projects.ts';
import { detectTutorial, findServerWorkspace, readAppJson } from './workspace/project.ts';
import { listAllIosSimsAsync, parseSimctlList } from './devices/ios.ts';
import {
  listAdbDevices,
  ownedAvdDeviceProfile,
  ownedAvdSerialResolver,
  type AdbDevices,
  type ResolvedAvdSerial,
} from './devices/android.ts';
import type { IosSimRecord } from './devices/ios.ts';
import { gitCommonDir, gitCommonDirOnDisk, linkedWorktreesOnDisk, repoRoot } from './workspace/worktree.ts';
import { inPrivacyProtectedFolder, readWorktreeGit } from './workspace/git-summary.ts';
import { readWorkspaceState, type WorkspaceState } from './workspace/workspace-state.ts';
import { readStats, statsProjectKey, type RunHistory } from './engine/stats.ts';
import {
  ACTIVE_BUILD_KEY,
  activeBuildState,
  buildReport,
  bundlingActivity,
  parseActiveBuild,
  type BuildReport,
} from './engine/build-progress.ts';
import { workspacePhase } from './engine/warm-progress.ts';
import { workspaceRecordingEnabled } from './workspace/recordings.ts';
import { resolveSettings, workspaceHiddenSetting } from './workspace/settings.ts';
import { listLeaseFiles, parseWorkspaceLeases } from './engine/device-lease.ts';
import { readIosDevices, type IosDeviceEntry } from './engine/ios-device.ts';
import { readEasSessionLedger } from './engine/eas-session-ledger.ts';
import { readMetroTunnel, readRemoteSession, readWorkspaceLaunches } from './supervisor/state.ts';
import {
  hostedIosPlacements,
  hostedAndroidRecords,
  hostedAndroidPlacements,
  parseHostedAndroidPlacement,
  unreadableHostedAndroid,
  hostedIosRecords,
  parseHostedIosPlacement,
  unreadableHostedIos,
  macosAppState,
  readMacosRecord,
  readBuildDetail,
  readDeviceIdleShutdowns,
  readIdleStop,
  readBuildHistory,
  readLastBuilds,
  readDevicePlacement,
  withStateReadCache,
  type MachineUsageState,
  archivedUsage,
  linkReplacedArchives,
  readArchives,
  type ArchivedWorkspace,
  type ArchivedUsage,
} from '@stim-cli/core/state';
import {
  createActivityReader,
  readWebActivity,
  tailLines,
  createDeviceProcessTables,
  type ActivityTarget,
  type DeviceProcessTables,
} from './devices/activity.ts';
import { createAppProcessReader } from './devices/app-process.ts';
import { hasMetroReverse } from './engine/app-install.ts';
import {
  addReverseMissingIssue,
  applyMachineMemory,
  deviceLeaseStates,
  environmentState,
  metroReverseTargets,
  remoteDeviceState,
  statusActivity,
  unprovisionedWorktrees,
  withWebFacts,
} from './status.ts';
import { readWebPage, readWebRecord, webFacts, type WebFacts } from './web/state.ts';
import { attributeMachineUsage, type WorkspaceProcessRoots } from './machine-usage.ts';
import { metroBundleState } from './metro-bundle.ts';
import { applyStatusMeasures } from './status-measures.ts';
import { readFootprints } from './footprint.ts';
import type { AndroidRuntimeFacts, EnvironmentState, WorktreeFacts } from './status.ts';
import {
  androidPhysicalReading,
  iosPhysicalReading,
  physicalDeviceStates,
  type PhysicalDeviceReading,
} from './physical-devices.ts';

type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

export const WATCH_GIT_MAX_AGE_MS = 60_000;

export function iosStatusName(ios: NonNullable<EnvironmentState['ios']>): string {
  const host = ios.host;
  return host && !ios.udid
    ? `${host.device?.name ?? 'iOS simulator'} (${host.device ? `iOS ${host.device.runtime.replace(/^iOS /, '')}` : 'runtime pending'}) on ${host.machine}${host.selected === 'auto' && host.reason ? ` (auto: ${host.reason})` : ''}`
    : (ios.name ?? ios.udid);
}

function applyHostedAndroidStates(
  state: EnvironmentState,
  saved: ReturnType<typeof readWorkspaceState>,
  factsBySlot: Awaited<ReturnType<typeof readHostedAndroidStatus>>,
): void {
  for (const [slot, record] of Object.entries(hostedAndroidRecords(saved))) {
    if (!parseHostedAndroidPlacement(record)) state.warnings.push(unreadableHostedAndroid(slot));
  }
  for (const [slot, facts] of Object.entries(factsBySlot)) {
    const local = slot === 'default' ? state.android : state.slots?.find((entry) => entry.slot === slot)?.android;
    const conflict = local && (local.state === 'detected' || local.state === 'unknown');
    const android = conflict ? { ...local, host: facts.android.host } : facts.android;
    if (conflict)
      state.warnings.push(
        `Slot ${slot} records both a local and hosted Android emulator (${facts.android.name} on ${facts.android.host?.machine}); run stim stop to reconcile them.`,
      );
    if (slot === 'default') state.android = android;
    else {
      state.slots ??= [];
      const savedSlot = state.slots.find((entry) => entry.slot === slot);
      if (savedSlot) savedSlot.android = android;
      else state.slots.push({ slot, ios: null, android });
    }
    if (facts.warning) state.warnings.push(facts.warning);
    state.live ||= facts.android.state === 'ready';
  }
}

function doctorRunTimes(proj: ProjectRecord): EnvironmentState['doctorRuns'] {
  const runs: NonNullable<EnvironmentState['doctorRuns']> = {};
  for (const platform of ['ios', 'android'] as const) {
    const at = proj.doctorRuns?.[platform]?.at;
    if (typeof at === 'string') runs[platform] = { at };
  }
  return Object.keys(runs).length ? runs : undefined;
}

export interface StatusSnapshot {
  archived: ArchivedWorkspace[];
  archivedUsage: ArchivedUsage;
  projects: [string, ProjectRecord][];
  states: EnvironmentState[];
  labelOnlyRoots: boolean[];
  leases: ReturnType<typeof deviceLeaseStates>;
  leaseNow: number;
  orphanWorktrees: WorktreeFacts[];
  worktrees: WorktreeFacts[];
  simsAvailable: boolean;
  simctlError: string | null;
  cwdRoot: string | null;
  tables: DeviceProcessTables;
  machine: MachineUsageState | null;
  roots: WorkspaceProcessRoots[];
  simNames: Record<string, string>;
}

export function readStatus(
  gitMaxAgeMs: number,
  simctlListing: string | null = null,
  archives?: ArchivedWorkspace[],
): Promise<StatusSnapshot> {
  return withStateReadCache(() => readStatusFacts(gitMaxAgeMs, simctlListing, archives));
}

async function readStatusFacts(
  gitMaxAgeMs: number,
  simctlListing: string | null,
  cachedArchives?: ArchivedWorkspace[],
): Promise<StatusSnapshot> {
  const cfg = loadConfig();
  const projects = Object.entries(cfg?.projects || {});
  const iosReads = projects.map(([path]) => readHostedIosStatus(hostedIosPlacements(readWorkspaceState(path))));
  const androidReads = projects.map(([path]) =>
    readHostedAndroidStatus(hostedAndroidPlacements(readWorkspaceState(path))),
  );
  const macosReads = projects.map(([path]) => readHostedMacosStatus(readMacosRecord(path)));
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
  const watching = gitMaxAgeMs > 0;
  const gitRead = watching ? readGitInto(worktrees, orphanWorktrees, gitMaxAgeMs) : null;

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
  const readPhysicalDevice = physicalDeviceReader();
  const simulatorUdids = new Set(
    [
      ...Object.keys(simsByUdid),
      ...projects.flatMap(([, proj]) =>
        projectDeviceSlots(proj).flatMap(({ platforms }) => platforms.ios?.deviceUdid ?? []),
      ),
    ].map((udid) => udid.toUpperCase()),
  );
  for (const [i, [path, proj]] of projects.entries()) {
    const { metro, supervisor } = running[i]!;
    const saved = readWorkspaceState(path);
    const builds = workspaceBuilds(path, saved, history);
    const web = webFacts(readWebRecord(path));
    const macosFacts = await macosReads[i]!;
    const macos = macosAppState(macosFacts.record);
    const activeBuild = parseActiveBuild(saved?.[ACTIVE_BUILD_KEY]);
    roots.push({
      path,
      supervisorPid: supervisor?.status === 'ours' ? supervisor.pid : null,
      build:
        activeBuild && builds.build?.state === 'running'
          ? { platform: activeBuild.platform, pid: activeBuild.claim.pid }
          : null,
      browserPids: browserPids(web),
      macosPids: [macos?.supervisor, macos?.app].flatMap((owner) =>
        owner && inspectProcessIdentity(owner) === 'same' ? [owner.pid] : [],
      ),
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
            idleShutdowns: readDeviceIdleShutdowns(saved),
            launches,
            leasedIds: new Set(
              deviceLeaseStates(leaseFiles, { root: path, now: leaseNow }).flatMap((lease) =>
                lease.mine && !lease.expired && lease.id ? [lease.id] : [],
              ),
            ),
            now: leaseNow,
            workspaces: projects.map(([other]) => other),
          },
        ),
        web,
      ),
    );
    const state = states[states.length - 1];
    if (state) {
      for (const [slot, record] of Object.entries(hostedIosRecords(saved))) {
        if (!parseHostedIosPlacement(record)) state.warnings.push(unreadableHostedIos(slot));
      }
      for (const [slot, facts] of Object.entries(await iosReads[i]!)) {
        const local = slot === 'default' ? state.ios : state.slots?.find((entry) => entry.slot === slot)?.ios;
        const conflict = local?.udid && (local.state === 'Booted' || local.state === 'unknown');
        const ios = conflict ? { ...local, host: facts.ios.host } : facts.ios;
        if (conflict)
          state.warnings.push(
            `Slot ${slot} records both a local and hosted iOS simulator (${iosStatusName(facts.ios)}); run stim stop to reconcile them.`,
          );
        if (slot === 'default') state.ios = ios;
        else {
          state.slots ??= [];
          const savedSlot = state.slots.find((entry) => entry.slot === slot);
          if (savedSlot) savedSlot.ios = ios;
          else state.slots.push({ slot, ios, android: null });
        }
        if (facts.warning) state.warnings.push(facts.warning);
        state.live ||= facts.ios.state === 'ready';
      }
      applyHostedAndroidStates(state, saved, await androidReads[i]!);
      const tunnel = readMetroTunnel(path);
      if (state.metro && tunnel?.kind === 'managed' && tunnel.port === state.metro.port && pidExists(tunnel.pid)) {
        state.metro.tunnel = { provider: tunnel.provider, url: tunnel.url };
      }
      if (macos) {
        state.macos = macos;
        if (macosFacts.warning) state.warnings.push(macosFacts.warning);
        state.live ||= macos.state === 'running' || macos.state === 'orphaned' || macos.build.state === 'running';
      }
      Object.assign(state, builds, workspacePhase(state.live, saved, { now: leaseNow }), {
        platforms: (() => {
          const context = {
            projectPath: path,
            gitCommonDir: gitCommonDirOnDisk(path),
            repoRoot: state.worktree?.path ?? path,
          };
          return detectPlatforms(path, { context, settings: resolveSettings(context) });
        })(),
        recording: { enabled: workspaceRecordingEnabled(path, proj, cfg, process.env) },
      });
      if (workspaceHiddenSetting(proj.settings)) state.hidden = true;
      const tutorial = detectTutorial(readAppJson(path));
      if (tutorial) state.tutorial = tutorial;
      const doctorRuns = doctorRunTimes(proj);
      if (doctorRuns) state.doctorRuns = doctorRuns;
    }
    const physicalDevices = physicalDeviceStates(leaseFiles, parseWorkspaceLeases(saved?.deviceLeases), {
      root: path,
      now: leaseNow,
      simulatorUdids,
      read: readPhysicalDevice,
    });
    if (state && physicalDevices.length) state.physicalDevices = physicalDevices;
    labelOnlyRoots.push(
      Boolean(
        proj.worktreeRoot &&
        !proj.bundleId &&
        !state?.metro &&
        !state?.ios &&
        !state?.android &&
        !state?.web &&
        !state?.macos,
      ),
    );
  }

  if (!watching) {
    const live = new Set(states.flatMap((state) => (state.live && state.worktree ? [state.worktree.path] : [])));
    await readGitInto(worktrees, orphanWorktrees, gitMaxAgeMs, live);
  }

  applyStatusMeasures(states, worktrees);
  readLogDerivedFacts(states);
  const tables = createDeviceProcessTables();
  readDeviceProcesses(states, tables, { projects, launchesByState });
  readMetroReverses(states, launchesByState);
  const sims = Object.values(simsByUdid);
  const simNames = Object.fromEntries(sims.map((sim) => [sim.udid.toUpperCase(), sim.name]));
  const busy = sims.some((sim) => sim.state === 'Booted');
  const machine = await readMachineUsage({ states, roots, simNames, tables, busy });
  const archives = cachedArchives ?? readArchives();
  const maxCount = machineNumber('archive.maxCount', cfg, process.env);
  return {
    archived: linkReplacedArchives(
      archives.slice(0, maxCount.value ?? 200),
      states.map((state) => state.path),
    ),
    archivedUsage: archivedUsage(archives),
    projects,
    states,
    labelOnlyRoots,
    leases,
    leaseNow,
    orphanWorktrees,
    worktrees,
    simsAvailable,
    simctlError,
    cwdRoot,
    tables,
    machine,
    roots,
    simNames,
  };
}

/** Sets the facts status derives from workspace logs, the running build's record and its detail file. */
function readLogDerivedFacts(states: EnvironmentState[]): void {
  const now = Date.now();
  for (const state of states) {
    const saved = readWorkspaceState(state.path);
    for (const devices of [{ slot: 'default', ios: state.ios, android: state.android }, ...(state.slots ?? [])]) {
      for (const platform of ['ios', 'android'] as const) {
        const device = devices[platform];
        const placement = readDevicePlacement(saved, platform, devices.slot);
        if (device) {
          if (placement) device.devicePlacement = placement;
          else delete device.devicePlacement;
        }
      }
    }
    if (state.metro) {
      const bundle = metroBundleState(tailLines(join(workspaceLogsDir(state.path), 'metro.ndjson')) ?? [], {
        running: state.metro.running,
        now,
      });
      if (bundle) state.metro.bundle = bundle;
      else delete state.metro.bundle;
    }
    if (state.build?.state === 'running') {
      const record = parseActiveBuild(readWorkspaceState(state.path)?.[ACTIVE_BUILD_KEY]);
      if (!record) {
        state.build = null;
        continue;
      }
      const report = buildReport(record, { state: activeBuildState(record.claim), history: undefined });
      const { outcome, expectedMs, expectedPhaseMs, basis, plannedPhases } = state.build;
      state.build =
        record.estimate || record.startedAt !== state.build.startedAt
          ? report
          : {
              ...report,
              outcome,
              expectedMs,
              expectedPhaseMs: report.phase === state.build.phase ? expectedPhaseMs : null,
              basis,
              plannedPhases,
            };
      const detail = record.phase === 'compile' ? readBuildDetail(state.path, record.claim.claimId) : null;
      if (detail) state.build.detail = detail;
      else delete state.build.detail;
      const activity = bundlingActivity(state.build.activity, state.build.platform, state.metro?.bundle);
      if (activity) state.build.activity = activity;
    }
  }
}

function browserPids(web: WebFacts | null): number[] {
  if (!web) return [];
  const chrome = web.record.chromeProcess?.pid;
  if (web.status === 'running') return [web.record.pid, ...(chrome ? [chrome] : [])];
  return web.status === 'orphaned' && chrome ? [chrome] : [];
}

/**
 * Attributes the host process table and the processes' footprints to their owners, and sets each environment's
 * `memoryMb` from them. Reads both only when a simulator is booted, a workspace is live or a build runs, so an idle
 * machine runs no `ps` and keeps the estimate.
 */
async function readMachineUsage({
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
}): Promise<MachineUsageState | null> {
  const needed = busy || states.some((state) => state.live || state.build?.state === 'running');
  const processes = needed ? tables.host() : null;
  if (!processes) return null;
  const footprints = await readFootprints();
  const machine = attributeMachineUsage({ processes, footprints, environments: states, roots, simNames });
  applyMachineMemory(states, machine);
  return machine;
}

/**
 * Rereads only the error counts, device activity and machine usage. With `machine`, and when the snapshot measured
 * machine usage, it reads the host process table again; it reuses every other subprocess fact of the full read.
 */
export async function refreshLightFacts(snapshot: StatusSnapshot, machine: boolean): Promise<void> {
  const fresh = createDeviceProcessTables();
  snapshot.tables = {
    host: machine && snapshot.machine ? fresh.host : snapshot.tables.host,
    android: snapshot.tables.android,
    tcpConnections: fresh.tcpConnections,
    clients: fresh.host,
  };
  withStateReadCache(() => {
    for (const state of snapshot.states) state.logs = logFacts(state.path);
    applyStatusMeasures(snapshot.states, snapshot.worktrees);
    readLogDerivedFacts(snapshot.states);
    readDeviceProcesses(snapshot.states, snapshot.tables, null);
  });
  if (machine && snapshot.machine) {
    snapshot.machine = await readMachineUsage({ ...snapshot, busy: true });
  }
}

async function readGitInto(
  worktrees: WorktreeFacts[],
  orphans: WorktreeFacts[],
  maxAgeMs: number,
  only?: ReadonlySet<string>,
): Promise<void> {
  const home = homedir();
  const byPath = await readWorktreeGit(worktrees, {
    maxAgeMs,
    skip: (w) =>
      (only !== undefined && !only.has(w.path)) ||
      (process.platform === 'darwin' && orphans.includes(w) && inPrivacyProtectedFolder(w.path, home)),
  });
  for (const worktree of worktrees) worktree.git = byPath.get(worktree.path) ?? null;
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
    const web = state.web;
    const port = web?.cdpEndpoint ? Number(new URL(web.cdpEndpoint).port) : null;
    if (web?.running && port) {
      web.page = readWebPage(state.path);
      const ownPids = [web.pid, web.supervisorPid].filter((pid): pid is number => pid !== null);
      web.activity = statusActivity(readWebActivity({ port, ownPids, workspace: state.path }, tables));
    }
  }
}

function readMetroReverses(
  states: EnvironmentState[],
  launchesByState: ReturnType<typeof readWorkspaceLaunches>[],
): void {
  for (const [i, state] of states.entries()) {
    for (const target of metroReverseTargets(state, launchesByState[i]!)) {
      const listing = getExecutor().runFileQuiet('adb', ['-s', target.serial, 'reverse', '--list'], {
        timeoutMs: 5000,
      });
      if (listing !== null && !hasMetroReverse(listing, target.metroPort)) addReverseMissingIssue(state, target);
    }
  }
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
    ...(builds.ios || builds.android || builds.macos ? { builds } : {}),
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

const PHYSICAL_DEVICE_LIST_TIMEOUT_MS = 5000;
const PHYSICAL_DEVICE_LIST_MAX_AGE_MS = 30_000;

const physicalDeviceLists: {
  ios?: { at: number; devices: IosDeviceEntry[] | null };
  android?: { at: number; devices: AdbDevices | null };
} = {};

function freshList<T>(entry: { at: number; devices: T } | undefined, read: () => T): { at: number; devices: T } {
  const now = Date.now();
  return entry && now - entry.at < PHYSICAL_DEVICE_LIST_MAX_AGE_MS ? entry : { at: now, devices: read() };
}

function physicalDeviceReader(): (platform: 'ios' | 'android', id: string) => PhysicalDeviceReading {
  return (platform, id) => {
    if (platform === 'ios') {
      physicalDeviceLists.ios = freshList(physicalDeviceLists.ios, () =>
        readIosDevices({ timeoutMs: PHYSICAL_DEVICE_LIST_TIMEOUT_MS }),
      );
      return iosPhysicalReading(physicalDeviceLists.ios.devices, id);
    }
    physicalDeviceLists.android = freshList(physicalDeviceLists.android, () => {
      try {
        return listAdbDevices({ timeoutMs: PHYSICAL_DEVICE_LIST_TIMEOUT_MS });
      } catch {
        return null;
      }
    });
    return androidPhysicalReading(physicalDeviceLists.android.devices, id);
  };
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
