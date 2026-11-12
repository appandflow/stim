import type { HostedAppStorage } from './hosted-apps.ts';
import type { ParkedHostedDeviceReport } from './hosted-devices.ts';
import type { AgentDeviceUsage, SwiftpmCacheUsage } from '@stim-cli/core/state';
import type { MachineCacheReport } from '../../devices/machine-cache-usage.ts';
import type { GradleVersionSweep } from './gradle-versions.ts';
import type { BuildLockInfo } from '../../engine/build-lock.ts';
import type { BuildSlotInfo } from '../../engine/build-slots.ts';
import type { GcSkip, OrphanedDevice } from './types.ts';
import type { OrphanedWorkspace, WorkspaceKeptCode, WorkspaceOutputsReport } from './workspaces.ts';
import type { GcCache } from './caches.ts';
import type { WorkspaceLogs, WorkspaceLogsKeptCode } from './logs.ts';
import {
  worktreeRemovalReason,
  type UnlistedWorktreeDir,
  type WorktreeBuildState,
  type WorktreeSkipCode,
  type WorktreeSweep,
} from './worktrees.ts';
import type { PullRequestLookup } from '../../workspace/pull-request.ts';
import type {
  DeviceLeaseGarbage,
  ParkedAvdReport,
  ParkedSimReport,
  SimulatorLaunchdFolder,
  StaleDeviceRecord,
  StaleProjectDevice,
  UnverifiedDevice,
} from './devices.ts';
import { unverifiedDeviceCommand } from './devices.ts';
import type { StaleEasLedgerEntry } from './eas-ledger.ts';
import type { StaleLedgerEntry } from './ledger.ts';
import type { StaleStatusCache } from './status-caches.ts';
import type { EasSessionSweep } from './eas-sessions.ts';
import type { FinishedDevice, OwnedDeviceDisk } from './finished-devices.ts';
import type { RecordingKeptCode, WorkspaceRecordings } from './recordings.ts';
import { tempLeftoverSection, type TempLeftoverReport } from './temp-leftovers.ts';
import type { OtherHome } from './other-homes.ts';
import type { TrashReport } from './trash.ts';
import type { MemoryProcess, MemoryReport, WatchmanRoot } from './memory.ts';

/** What Stim keeps on disk, as the storage report of `stim gc --dry-run --json` lists it. */
export interface GcReport {
  skipped: GcSkip[];
  deadProjects: string[];
  orphanedPorts?: { project: string; label: string; port: number }[];
  invalidProjects: string[];
  orphanedWorkspaces: OrphanedWorkspace[];
  parkedSims: ParkedSimReport[];
  parkedAvds: ParkedAvdReport[];
  parkedHostedDevices: ParkedHostedDeviceReport[];
  hostedAppStorage?: HostedAppStorage[];
  otherHomes?: OtherHome[];
  orphanedDevices: OrphanedDevice[];
  unverifiedDevices: UnverifiedDevice[];
  simulatorLaunchdFolders: SimulatorLaunchdFolder[];
  staleDevices: StaleProjectDevice[];
  finishedDevices: FinishedDevice[];
  ownedDeviceDisk: OwnedDeviceDisk[];
  staleDeviceRecords: StaleDeviceRecord[];
  staleLedgerEntries: StaleLedgerEntry[];
  staleEasLedgerEntries: StaleEasLedgerEntry[];
  staleStatusCaches: StaleStatusCache[];
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[]; unresolved?: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[]; unresolved?: BuildSlotInfo[] };
  deviceLeases: DeviceLeaseGarbage;
  deviceSweepNotices: string[];
  easSessionSweep: EasSessionSweep;
  agentDeviceUsage?: AgentDeviceUsage | null;
  swiftpmCacheUsage?: SwiftpmCacheUsage | null;
  machineCaches?: MachineCacheReport | null;
  tempLeftovers?: TempLeftoverReport | null;
  trash?: TrashReport | null;
  gradleVersions?: GradleVersionSweep | null;
  caches: GcCache[];
  workspaceOutputs: WorkspaceOutputsReport | null;
  workspaceLogs: WorkspaceLogs[];
  recordings: WorkspaceRecordings[];
  worktreeSweep?: WorktreeSweep | null;
  memory?: MemoryReport | null;
}

function unlistedWorktreeRemedy(dir: UnlistedWorktreeDir): string {
  return `rm -rf '${dir.path.replaceAll("'", "'\\''")}'`;
}

interface GcJsonLock {
  /** @internal Carries no compatibility: a path inside the Stim home. */
  path: string;
  platform: string;
  key: string | null;
  /** @internal Carries no compatibility. */
  pid: number | null;
  projectRoot: string | null;
}

function jsonLock({ path, platform, key, pid, projectRoot }: BuildLockInfo): GcJsonLock {
  return { path, platform, key, pid, projectRoot };
}

function jsonPullRequest(lookup: PullRequestLookup | null): GcJsonSections['linkedWorktrees'][number]['pullRequest'] {
  const pr = lookup && 'pullRequest' in lookup ? lookup.pullRequest : null;
  return pr ? { number: pr.number, state: pr.state, url: pr.url, containsHead: pr.containsHead } : null;
}

function linkedWorktreesJson(sweep: WorktreeSweep | null): GcJsonSections['linkedWorktrees'] {
  if (!sweep) return [];
  return sweep.worktrees.map((w) => ({
    path: w.path,
    idleDays: w.idleDays,
    mergedInto: w.merge?.merged ? w.merge.into : null,
    pullRequest: jsonPullRequest(w.pullRequest),
    pullRequestUnknown: w.pullRequest && 'unavailable' in w.pullRequest ? w.pullRequest.unavailable : null,
    willRemove: w.skipCode === null,
    reason: w.skipCode,
    detail: w.skipped ?? worktreeRemovalReason(w, sweep),
    eligibleAt: w.eligibleAt === null ? null : new Date(w.eligibleAt).toISOString(),
    buildState: w.buildState ?? null,
  }));
}

/** The storage sections of `gc --dry-run --json`. Sections contain entries or a report-only usage payload. */
export interface GcJsonSections {
  deadProjects: { path: string }[];
  invalidProjects: { path: string }[];
  orphanedPorts: { project: string; label: string; port: number }[];
  orphanedWorkspaces: { dir: string; projectRoot: string | null; bytes: number | null }[];
  linkedWorktrees: {
    path: string;
    idleDays: number | null;
    mergedInto: string | null;
    pullRequest: { number: number; state: 'open' | 'merged' | 'closed'; url: string; containsHead: boolean } | null;
    pullRequestUnknown: string | null;
    willRemove: boolean;
    reason: WorktreeSkipCode | null;
    detail: string;
    eligibleAt: string | null;
    buildState: WorktreeBuildState | null;
  }[];
  unlistedWorktreeDirectories: { path: string; repository: string; bytes: number | null; remedy: string }[];
  parkedSimulators: ParkedSimReport[];
  parkedEmulators: ParkedAvdReport[];
  parkedHostedDevices: ParkedHostedDeviceReport[];
  hostedAppStorage: HostedAppStorage[];
  otherHomes: OtherHome[];
  orphanedDevices: {
    kind: 'ios' | 'android';
    id: string;
    name: string;
    bytes: number | null;
    directory: string | null;
  }[];
  unverifiedDevices: { kind: 'ios' | 'android'; id: string; name: string; command: string }[];
  simulatorLaunchdFolders: { udid: string; path: string; bytes: number | null; command: string }[];
  staleDevices: {
    kind: 'ios' | 'android';
    id: string;
    name: string;
    project: string;
    slot: string | null;
    idleDays: number;
    bytes: number | null;
  }[];
  finishedDevices: {
    kind: 'ios' | 'android';
    id: string;
    name: string;
    project: string;
    slot: string | null;
    bytes: number | null;
    reason: string;
  }[];
  ownedDeviceDisk: OwnedDeviceDisk[];
  staleDeviceRecords: { kind: 'ios' | 'android'; id: string; project: string; slot: string | null }[];
  staleLedgerEntries: { kind: 'ios' | 'android' | 'web'; id: string }[];
  staleEasLedgerEntries: { id: string; workspaceRoot: string }[];
  staleStatusCaches: { kind: 'disk-usage' | 'pull-request' | 'git-merge'; path: string; file: string; bytes: number }[];
  orphanedEasSessions: {
    id: string;
    name: string;
    platform: 'ios' | 'android';
    status: string;
    projectScope: string;
  }[];
  staleBuildLocks: GcJsonLock[];
  staleBuildSlots: { path: string; index: number | null; pid: number | null; projectRoot: string | null }[];
  unresolvedBuildClaims: { kind: 'lock' | 'slot'; path: string }[];
  buildsInProgress: GcJsonLock[];
  expiredDeviceLeases: {
    path: string;
    platform: string;
    id: string;
    deviceName: string | null;
    holder: string | null;
    expiresAt: string | null;
  }[];
  keptDeviceLeases: { name: string; path: string; detail: string }[];
  deviceSweepNotices: { message: string }[];
  easSessionSweepNotices: { message: string }[];
  skipped: { path: string; detail: string }[];
  workspaceLogs: {
    dir: string;
    projectRoot: string | null;
    bytes: number;
    trimBytes: number;
    willTrim: boolean;
    reason: WorkspaceLogsKeptCode | null;
    detail: string | null;
  }[];
  recordings: {
    dir: string;
    projectRoot: string | null;
    bytes: number;
    deleteBytes: number;
    willDelete: boolean;
    withWorkspace: boolean;
    reason: RecordingKeptCode | null;
    detail: string | null;
  }[];
  workspaceBuildOutputs: {
    dir: string;
    projectRoot: string | null;
    inTreeDirs: string[];
    bytes: number | null;
    idleDays: number | null;
    willClear: boolean;
    reason: WorkspaceKeptCode | null;
    detail: string | null;
  }[];
  agentDevice: AgentDeviceUsage | null;
  swiftpmCache: SwiftpmCacheUsage | null;
  machineCaches: MachineCacheReport | null;
  tempLeftovers: ReturnType<typeof tempLeftoverSection>;
  trash: TrashReport | null;
  gradleVersions: GradleVersionSweep | null;
  caches: {
    name: string;
    dir: string;
    source: 'registered' | 'detected' | null;
    bytes: number | null;
    note: string | null;
    willEmpty: boolean;
    emptySkipped: string | null;
    scopedEmpty: { willEmpty: boolean; emptySkipped: string | null } | null;
  }[];
  memory: MemoryProcess[];
  watchmanRoots: WatchmanRoot[];
  memoryNotices: { message: string }[];
}

export function gcReportSections({
  skipped = [],
  deadProjects = [],
  orphanedPorts = [],
  invalidProjects = [],
  orphanedWorkspaces = [],
  worktreeSweep = null,
  parkedSims = [],
  parkedAvds = [],
  parkedHostedDevices = [],
  hostedAppStorage = [],
  otherHomes = [],
  orphanedDevices = [],
  unverifiedDevices = [],
  simulatorLaunchdFolders = [],
  staleDevices = [],
  finishedDevices = [],
  ownedDeviceDisk = [],
  staleDeviceRecords = [],
  staleLedgerEntries = [],
  staleEasLedgerEntries = [],
  staleStatusCaches = [],
  buildLocks = { stale: [], live: [], unresolved: [] },
  buildSlots = { stale: [], live: [], unresolved: [] },
  deviceLeases = { expired: [], kept: [] },
  deviceSweepNotices = [],
  easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
  workspaceOutputs = null,
  workspaceLogs = [],
  recordings = [],
  agentDeviceUsage = null,
  swiftpmCacheUsage = null,
  machineCaches = null,
  tempLeftovers = null,
  trash = null,
  gradleVersions = null,
  caches = [],
  memory = null,
}: Partial<GcReport>): GcJsonSections {
  return {
    deadProjects: deadProjects.map((path) => ({ path })),
    invalidProjects: invalidProjects.map((path) => ({ path })),
    orphanedPorts: orphanedPorts.map(({ project, label, port }) => ({ project, label, port })),
    orphanedWorkspaces: orphanedWorkspaces.map(({ dir, projectRoot, bytes }) => ({
      dir,
      projectRoot,
      bytes: bytes ?? null,
    })),
    linkedWorktrees: linkedWorktreesJson(worktreeSweep),
    unlistedWorktreeDirectories: (worktreeSweep?.unlisted ?? []).map((dir) => ({
      path: dir.path,
      repository: dir.repository,
      bytes: dir.bytes,
      remedy: unlistedWorktreeRemedy(dir),
    })),
    parkedSimulators: parkedSims.map(({ udid, name, model, runtime, parkedAt, app, bytes, listed }) => ({
      udid,
      name,
      model,
      runtime,
      parkedAt,
      app,
      bytes,
      listed,
    })),
    parkedEmulators: parkedAvds.map(({ name, systemImage, deviceProfile, parkedAt, app, bytes, listed }) => ({
      name,
      systemImage,
      deviceProfile,
      parkedAt,
      app,
      bytes,
      listed,
    })),
    parkedHostedDevices,
    hostedAppStorage,
    otherHomes,
    orphanedDevices: orphanedDevices.map((d) => ({
      kind: d.kind,
      id: d.id,
      name: d.name,
      bytes: d.bytes ?? null,
      directory: d.orphanedDirectory?.directory ?? null,
    })),
    unverifiedDevices: unverifiedDevices.map((d) => ({
      kind: d.kind,
      id: d.id,
      name: d.name,
      command: unverifiedDeviceCommand(d),
    })),
    simulatorLaunchdFolders: simulatorLaunchdFolders.map(({ udid, path, bytes }) => ({
      udid,
      path,
      bytes,
      command: `rm -rf ${JSON.stringify(path)}`,
    })),
    staleDevices: staleDevices.map((d) => ({
      kind: d.kind,
      id: d.id,
      name: d.name,
      project: d.project,
      slot: d.slot ?? null,
      idleDays: d.idleDays,
      bytes: d.bytes ?? null,
    })),
    finishedDevices: finishedDevices.map((d) => ({
      kind: d.kind,
      id: d.id,
      name: d.name,
      project: d.project,
      slot: d.slot ?? null,
      bytes: d.bytes ?? null,
      reason: d.reason,
    })),
    ownedDeviceDisk,
    staleDeviceRecords: staleDeviceRecords.map((r) => ({
      kind: r.kind,
      id: r.id,
      project: r.project,
      slot: r.slot ?? null,
    })),
    staleLedgerEntries: staleLedgerEntries.map(({ kind, id }) => ({ kind, id })),
    staleEasLedgerEntries: staleEasLedgerEntries.map(({ id, workspaceRoot }) => ({ id, workspaceRoot })),
    staleStatusCaches: staleStatusCaches.map(({ kind, path, file, bytes }) => ({ kind, path, file, bytes })),
    orphanedEasSessions: easSessionSweep.orphaned.map((s) => ({
      id: s.id,
      name: s.name,
      platform: s.platform,
      status: s.status,
      projectScope: s.projectScope,
    })),
    staleBuildLocks: buildLocks.stale.map(jsonLock),
    staleBuildSlots: buildSlots.stale.map((s) => ({
      path: s.path,
      index: s.index,
      pid: s.pid,
      projectRoot: s.projectRoot,
    })),
    unresolvedBuildClaims: [
      ...(buildLocks.unresolved ?? []).map((l) => ({ kind: 'lock' as const, path: l.path })),
      ...(buildSlots.unresolved ?? []).map((s) => ({ kind: 'slot' as const, path: s.path })),
    ],
    buildsInProgress: buildLocks.live.map(jsonLock),
    expiredDeviceLeases: deviceLeases.expired.map((entry) => ({
      path: entry.path,
      platform: entry.platform,
      id: entry.id ?? entry.name,
      deviceName: entry.lease?.deviceName ?? null,
      holder: entry.lease?.holder ?? null,
      expiresAt: entry.lease?.expiresAt ?? null,
    })),
    keptDeviceLeases: deviceLeases.kept.map(({ name, path, reason }) => ({ name, path, detail: reason })),
    deviceSweepNotices: deviceSweepNotices.map((message) => ({ message })),
    easSessionSweepNotices: easSessionSweep.notices.map((message) => ({ message })),
    skipped: skipped.map(({ dir, reason }) => ({ path: dir, detail: reason })),
    workspaceLogs: workspaceLogs.map((w) => ({
      dir: w.dir,
      projectRoot: w.projectRoot,
      bytes: w.bytes,
      trimBytes: w.trimBytes,
      willTrim: w.willTrim,
      reason: w.keptCode,
      detail: w.keptReason,
    })),
    recordings: recordings.map((r) => ({
      dir: r.dir,
      projectRoot: r.projectRoot,
      bytes: r.bytes,
      deleteBytes: r.deleteBytes,
      willDelete: r.willDelete,
      withWorkspace: r.withWorkspace,
      reason: r.keptCode,
      detail: r.keptReason,
    })),
    workspaceBuildOutputs: (workspaceOutputs?.workspaces ?? []).map((w) => ({
      dir: w.dir,
      projectRoot: w.projectRoot,
      inTreeDirs: w.inTreeDirs,
      bytes: w.bytes,
      idleDays: w.idleDays,
      willClear: w.willClear,
      reason: w.keptCode,
      detail: w.keptReason,
    })),
    caches: caches.map((c) => ({
      name: c.name,
      dir: c.dir,
      source: c.source ?? null,
      bytes: c.bytes ?? null,
      note: c.note || null,
      willEmpty: Boolean(c.willEmpty),
      emptySkipped: c.emptySkipped ?? null,
      scopedEmpty: c.scopedEmpty ?? null,
    })),
    agentDevice: agentDeviceUsage,
    swiftpmCache: swiftpmCacheUsage,
    machineCaches,
    tempLeftovers: tempLeftoverSection(tempLeftovers),
    trash,
    gradleVersions,
    memory: memory?.processes ?? [],
    watchmanRoots: memory?.watchmanRoots ?? [],
    memoryNotices: (memory?.notices ?? []).map((message) => ({ message })),
  };
}
