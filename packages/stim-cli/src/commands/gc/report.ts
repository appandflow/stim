import type { ParkedHostedDeviceReport } from './hosted-devices.ts';
import type { MaintenancePreview } from '../../maintenance/preview.ts';
import { archiveLines, type ArchiveSelection } from './archives.ts';
import type { AgentDeviceUsage, SwiftpmCacheUsage } from '@stim-cli/core/state';
import { swiftpmCacheLines } from '../../devices/swiftpm-cache-usage-output.ts';
import { agentDeviceLines } from '../../devices/agent-device-usage-output.ts';
import { machineCacheLines } from '../../devices/machine-cache-usage-output.ts';
import type { MachineCacheReport } from '../../devices/machine-cache-usage.ts';
import { gradleVersionLines, type GradleVersionSweep } from './gradle-versions.ts';
import { formatLongDuration, shortUdid } from '../../command-output.ts';
import { claimRemoveCommand } from '../../ownership-claim.ts';
import { formatBytes } from '../../fs-util.ts';
import type { BuildLockInfo } from '../../engine/build-lock.ts';
import type { BuildSlotInfo } from '../../engine/build-slots.ts';
import type { GcSkip, OrphanedDevice } from './types.ts';
import {
  REBUILD_COST,
  sizeText,
  WORKSPACE_OUTPUT_DIRS,
  type OrphanedWorkspace,
  type WorkspaceKeptCode,
  type WorkspaceOutputsReport,
} from './workspaces.ts';
import { includesParkedDevices, type GcCache } from './caches.ts';
import type { WorkspaceLogs, WorkspaceLogsKeptCode } from './logs.ts';
import {
  worktreePullRequestNote,
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
  StaleDeviceRecord,
  StaleProjectDevice,
  UnverifiedDevice,
} from './devices.ts';
import { unverifiedDeviceCommand } from './devices.ts';
import type { StaleEasLedgerEntry } from './eas-ledger.ts';
import type { StaleLedgerEntry } from './ledger.ts';
import { statusCacheLines, type StaleStatusCache } from './status-caches.ts';
import type { EasSessionSweep } from './eas-sessions.ts';
import {
  finishedDeviceLines,
  ownedDeviceDiskLines,
  type FinishedDevice,
  type OwnedDeviceDisk,
} from './finished-devices.ts';
import { idleDeviceLines, type IdleDevice } from './idle.ts';
import { recordingLines, type RecordingKeptCode, type WorkspaceRecordings } from './recordings.ts';
import { tempLeftoverLines, tempLeftoverSection, type TempLeftoverReport } from './temp-leftovers.ts';
import { trashLines, type TrashReport } from './trash.ts';
import type { WorktreeDependencies } from './dependencies.ts';
import { memoryCacheKind, memoryLines, type MemoryProcess, type MemoryReport, type WatchmanRoot } from './memory.ts';

export interface GcReport {
  maintenance?: MaintenancePreview;
  archives?: ArchiveSelection;
  skipped: GcSkip[];
  deadProjects: string[];
  orphanedPorts?: { project: string; label: string; port: number }[];
  invalidProjects: string[];
  orphanedWorkspaces: OrphanedWorkspace[];
  parkedSims: ParkedSimReport[];
  parkedAvds: ParkedAvdReport[];
  parkedHostedDevices: ParkedHostedDeviceReport[];
  orphanedDevices: OrphanedDevice[];
  unverifiedDevices: UnverifiedDevice[];
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
  idleDevices: IdleDevice[];
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
  worktreeDependencies?: WorktreeDependencies | null;
  workspaceLogs: WorkspaceLogs[];
  recordings: WorkspaceRecordings[];
  worktreeSweep?: WorktreeSweep | null;
  memory?: MemoryReport | null;
  cacheScope: string | null;
  olderThan: number | null;
  all: boolean;
}

function shortKey(key: unknown) {
  const text = String(key ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

function parkedAge(parkedAt: string, now: number): string {
  const at = Date.parse(parkedAt);
  if (!Number.isFinite(at)) return 'parked at an unknown time';
  return `parked ${formatLongDuration(Math.max(0, now - at))} ago`;
}

const PARKED_DELETE_NOTE = '              --delete attempts verified deletions and keeps failures.';
const PARKED_ERASE_NOTE = '              --delete erases each verified device (apps and data) and keeps it parked.';

function parkedApp(app: string | null): string {
  return app ? ` ${app}` : '';
}

function formatParkedSimReport(parkedSims: readonly ParkedSimReport[], now: number, erase: boolean): string[] {
  if (parkedSims.length === 0) return [];
  const known = parkedSims.filter((sim) => sim.bytes !== null);
  const total = known.reduce((sum, sim) => sum + (sim.bytes ?? 0), 0);
  const size = known.length === parkedSims.length ? `, ${formatBytes(total)}` : '';
  const lines = [`Parked simulators (${parkedSims.length}${size}):`];
  for (const sim of parkedSims) {
    const model = [sim.model, sim.runtime].filter(Boolean).join(' ');
    const age = parkedAge(sim.parkedAt, now);
    const bytes = sim.bytes === null ? '' : ` ${formatBytes(sim.bytes)}`;
    const gone =
      sim.listed === false ? ' - not on this machine' : sim.listed === null ? ' - listing unavailable; kept' : '';
    lines.push(
      `  ios ${sim.name} (${shortUdid(sim.udid)})${model ? ` ${model}` : ''} ${age}${parkedApp(sim.app)}${bytes}${gone}`,
    );
  }
  lines.push(erase ? PARKED_ERASE_NOTE : PARKED_DELETE_NOTE);
  return lines;
}

function formatParkedAvdReport(parkedAvds: readonly ParkedAvdReport[], now: number, erase: boolean): string[] {
  if (!parkedAvds.length) return [];
  const lines: string[] = [];
  lines.push(`Parked emulators (${parkedAvds.length}):`);
  for (const avd of parkedAvds) {
    const listed =
      avd.listed === false ? ' - not on this machine' : avd.listed === null ? ' - listing unavailable; kept' : '';
    lines.push(
      `  android ${avd.name} ${avd.systemImage}${avd.deviceProfile ? ` ${avd.deviceProfile}` : ''} ${parkedAge(avd.parkedAt, now)}${parkedApp(avd.app)}${avd.bytes === null ? '' : ` ${formatBytes(avd.bytes)}`}${listed}`,
    );
  }
  lines.push(erase ? PARKED_ERASE_NOTE : PARKED_DELETE_NOTE);
  return lines;
}

function formatParkedHostedDeviceReport(devices: readonly ParkedHostedDeviceReport[] = [], now: number): string[] {
  if (!devices.length) return [];
  const lines = [`Parked hosted devices (${devices.length}):`];
  for (const device of devices) {
    const ledger =
      device.listed === true
        ? ''
        : device.listed === false
          ? ' - already removed; stim-server clears the marker'
          : ' - ledger ownership unavailable; kept';
    lines.push(
      `  ${device.platform} ${device.name ?? 'unknown device'} client ${device.client} session ${device.session} ${parkedAge(device.parkedAt, now)}${ledger}`,
    );
  }
  lines.push(PARKED_DELETE_NOTE);
  return lines;
}

function projectEntryLines(header: string, paths: string[]): string[] {
  return paths.length ? [header, ...paths.map((path) => `  ${path}`)] : [];
}

function unresolvedLockLines(
  locks: { unresolved?: readonly { path: string }[] },
  slots: { unresolved?: readonly { path: string }[] },
): string[] {
  const entries = [...(locks.unresolved ?? []), ...(slots.unresolved ?? [])];
  if (entries.length === 0) return [];
  return [
    `Build locks and slots Stim cannot resolve (${entries.length}) - NOT touched, because a dead holder and a live one cannot be told apart:`,
    ...entries.flatMap((entry) => [`  ${entry.path}`, `              ${claimRemoveCommand(entry.path)}`]),
    '              run that yourself once you know nothing is building with it',
  ];
}

function scopeLine(cacheScope: string): string {
  if (memoryCacheKind(cacheScope)) return `Cache scope: "${cacheScope}". Only these helper processes were inspected.`;
  return includesParkedDevices(cacheScope)
    ? `Cache scope: "${cacheScope}". Unparked devices, project entries and locks were not inspected.`
    : `Cache scope: "${cacheScope}". Devices, project entries and locks were not inspected.`;
}

function maintenanceReportLines(maintenance: MaintenancePreview | undefined): string[] {
  const lines: string[] = [];
  if (maintenance) {
    lines.push(`Automatic maintenance (${maintenance.mode === 'report' ? 'report only' : maintenance.mode}):`);
    if (maintenance.note) lines.push(`  ${maintenance.note}`);
    for (const action of maintenance.actions)
      lines.push(`  ${action.kind}: ${action.target} (${formatBytes(action.bytes)}): ${action.reason}`);
    for (const skip of maintenance.skips) lines.push(`  kept ${skip.target}: ${skip.reason}`);
    for (const reason of maintenance.blocked) lines.push(`  blocked: ${reason}`);
    if (!maintenance.actions.length && !maintenance.blocked.length) lines.push('  no actions planned');
  }
  return lines;
}

function staleEasLedgerLines(entries: StaleEasLedgerEntry[] = []): string[] {
  if (!entries.length) return [];
  return [
    `Stale EAS ledger entries (${entries.length}) - the id is not a valid EAS session id and the workspace is gone:`,
    ...entries.map((entry) => `  ${entry.id} (workspace ${entry.workspaceRoot})`),
    '              --delete forgets the LEDGER ENTRY only; no EAS session is contacted.',
  ];
}

export function formatGcReport(
  {
    maintenance,
    archives,
    skipped = [],
    deadProjects = [],
    orphanedPorts,
    invalidProjects = [],
    orphanedWorkspaces = [],
    parkedSims = [],
    parkedAvds = [],
    parkedHostedDevices,
    orphanedDevices = [],
    unverifiedDevices = [],
    staleDevices = [],
    finishedDevices,
    ownedDeviceDisk,
    staleDeviceRecords = [],
    staleLedgerEntries = [],
    staleEasLedgerEntries,
    staleStatusCaches = [],
    buildLocks = { stale: [], live: [], unresolved: [] },
    buildSlots = { stale: [], live: [], unresolved: [] },
    deviceLeases = { expired: [], kept: [] },
    idleDevices = [],
    deviceSweepNotices = [],
    easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    agentDeviceUsage = null,
    swiftpmCacheUsage,
    machineCaches,
    tempLeftovers,
    trash,
    gradleVersions,
    caches = [],
    workspaceOutputs = null,
    worktreeDependencies,
    workspaceLogs = [],
    recordings = [],
    worktreeSweep = null,
    memory,
    cacheScope = null,
    olderThan = null,
  }: Partial<GcReport>,
  { now = Date.now() }: { now?: number } = {},
): string[] {
  const lines: string[] = archiveLines(archives);
  const parkedHostedLines = formatParkedHostedDeviceReport(parkedHostedDevices, now);
  const easLedgerLines = staleEasLedgerLines(staleEasLedgerEntries);
  const finishedLines = finishedDeviceLines(finishedDevices);
  const staleLocks = buildLocks?.stale ?? [];
  const liveLocks = buildLocks?.live ?? [];
  const staleSlots = buildSlots?.stale ?? [];
  const expiredLeases = deviceLeases?.expired ?? [];

  if (cacheScope) {
    lines.push(scopeLine(cacheScope));
  } else if (
    [
      deadProjects,
      invalidProjects,
      orphanedWorkspaces,
      parkedSims,
      parkedAvds,
      parkedHostedLines,
      orphanedDevices,
      staleDevices,
      finishedLines,
      staleDeviceRecords,
      staleLedgerEntries,
      easLedgerLines,
      staleStatusCaches,
      staleLocks,
      staleSlots,
      expiredLeases,
      easSessionSweep.orphaned,
      workspaceOutputs?.workspaces.filter((entry) => entry.willClear) ?? [],
      dependencyCandidates(worktreeDependencies),
      workspaceLogs.filter((entry) => entry.willTrim),
      worktreeSweep?.worktrees.filter((entry) => !entry.skipped) ?? [],
    ].every((found) => found.length === 0)
  ) {
    const reasons = [];
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} could not be checked`);
    }
    if (deviceSweepNotices.length > 0) {
      reasons.push('device sweep incomplete');
    }
    if (easSessionSweep.notices.length > 0) {
      reasons.push('EAS session sweep incomplete');
    }
    if (reasons.length > 0) {
      lines.push(`Nothing to reclaim (${reasons.join('; ')}; see below).`);
    } else {
      lines.push('Nothing to reclaim.');
    }
  }

  lines.push(...projectEntryLines(`Dead project entries (${deadProjects.length}):`, deadProjects));
  lines.push(
    ...projectEntryLines(
      `Invalid project entries (${invalidProjects.length}) - the key is not an absolute path:`,
      invalidProjects,
    ),
  );

  lines.push(...namedPortLines(orphanedPorts));
  lines.push(...orphanedWorkspaceLines(orphanedWorkspaces));
  lines.push(...worktreeSweepLines(worktreeSweep));
  lines.push(...unlistedWorktreeLines(worktreeSweep));

  lines.push(...formatParkedSimReport(parkedSims, now, cacheScope !== null));
  lines.push(...formatParkedAvdReport(parkedAvds, now, cacheScope !== null));
  lines.push(...parkedHostedLines);

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})${deviceSizeSuffix(d)}`);
  }

  if (unverifiedDevices.length) {
    lines.push(
      `Unrecognized stim-* devices (${unverifiedDevices.length}) - NOT deleted, because this Stim home has no record of creating them:`,
    );
    for (const d of unverifiedDevices) {
      lines.push(`  ${d.kind} ${d.name} (${d.id})`);
      lines.push(`              ${unverifiedDeviceCommand(d)}`);
    }
    lines.push('              run that yourself if you no longer need it');
  }

  if (staleDevices.length) {
    lines.push(`Stale owned devices (${staleDevices.length}) - workspace unused for ${olderThan ?? '?'}d or more:`);
    for (const d of staleDevices) {
      lines.push(`  ${d.kind} ${d.name} (${d.id})${deviceSizeSuffix(d)}`);
      lines.push(`              ${d.project} (idle ${d.idleDays}d)`);
    }
  }

  lines.push(...finishedLines, ...ownedDeviceDiskLines(ownedDeviceDisk));

  lines.push(...idleDeviceLines(idleDevices));

  if (staleDeviceRecords.length) {
    lines.push(`Stale device records (${staleDeviceRecords.length}) - the device is gone, the project is not:`);
    for (const r of staleDeviceRecords) {
      lines.push(`  ${r.kind} ${r.id} is not on this machine`);
      lines.push(`              recorded by ${r.project}`);
    }
    lines.push('              --delete clears the RECORD only; there is no device left to touch.');
  }

  if (staleLedgerEntries.length) {
    lines.push(
      `Stale device ledger entries (${staleLedgerEntries.length}) - Stim created these devices or browser profiles; they are gone:`,
    );
    for (const entry of staleLedgerEntries) lines.push(`  ${entry.kind} ${entry.id} is not on this machine`);
    lines.push('              --delete forgets the LEDGER ENTRY only; there is no device left to touch.');
  }

  lines.push(...easLedgerLines);

  lines.push(...statusCacheLines(staleStatusCaches));

  if (easSessionSweep.orphaned.length) {
    lines.push(`Orphaned EAS sessions (${easSessionSweep.orphaned.length}) - current EAS project only:`);
    for (const session of easSessionSweep.orphaned) {
      const details = [session.platform, session.status].filter(Boolean).join(', ');
      lines.push(`  ${session.name} (${session.id})${details ? ` [${details}]` : ''}`);
      lines.push(`              project scope: ${session.projectScope}`);
      lines.push(`              remedy: eas simulator:stop --id ${session.id}`);
    }
  }

  if (staleLocks.length) {
    lines.push(`Stale build locks (${staleLocks.length}) - the process that was building is gone:`);
    for (const lock of staleLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid ?? '?'} is not running)`);
      lines.push(`              started by ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (staleSlots.length) {
    lines.push(`Stale build slots (${staleSlots.length}) - the process that was building is gone:`);
    for (const slot of staleSlots) {
      lines.push(`  slot ${slot.index ?? '?'} (pid ${slot.pid ?? '?'} is not running)`);
      lines.push(`              held by ${slot.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  lines.push(...unresolvedLockLines(buildLocks, buildSlots));

  if (liveLocks.length) {
    lines.push(`Builds in progress (${liveLocks.length}) - NOT touched, by anything:`);
    for (const lock of liveLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid})`);
      lines.push(`              building in ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  lines.push(...leaseGarbageLines(deviceLeases));

  if (deviceSweepNotices.length) {
    lines.push(`Device sweep notices (${deviceSweepNotices.length}):`);
    for (const notice of deviceSweepNotices) lines.push(`  ${notice}`);
  }

  if (easSessionSweep.notices.length) {
    lines.push(`EAS session sweep notices (${easSessionSweep.notices.length}):`);
    for (const notice of easSessionSweep.notices) lines.push(`  ${notice}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as dead:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  lines.push(...worktreeDependencyLines(worktreeDependencies));
  lines.push(...workspaceLogLines(workspaceLogs));
  lines.push(...recordingLines(recordings));
  lines.push(...cacheLines(caches, workspaceOutputs));
  lines.push(...agentDeviceLines(agentDeviceUsage, true, now));
  lines.push(...swiftpmCacheLines(swiftpmCacheUsage, now));
  lines.push(...machineCacheLines(machineCaches, now));
  lines.push(...tempLeftoverLines(tempLeftovers));
  lines.push(...trashLines(trash));
  lines.push(...gradleVersionLines(gradleVersions));
  lines.push(...memoryLines(memory, memoryCacheKind(cacheScope), now));
  lines.push(...maintenanceReportLines(maintenance));

  return lines;
}

function dependencyCandidates(found: WorktreeDependencies | null | undefined): string[] {
  return found?.candidates.map(({ path }) => path) ?? [];
}

function worktreeDependencyLines(found: WorktreeDependencies | null | undefined): string[] {
  if (!found || (!found.candidates.length && !found.skips.length)) return [];
  const lines = [
    `Worktree dependencies (${found.candidates.length} of ${found.candidates.length + found.skips.length} would be LIGHTENED; the next start, ios or android restores them with worktree warm):`,
  ];
  for (const { path } of found.candidates) lines.push(`  ${path}`, '              would be LIGHTENED');
  for (const { target, reason } of found.skips) lines.push(`  ${target}`, `              kept: ${reason}`);
  return lines;
}

function workspaceLogLines(workspaceLogs: readonly WorkspaceLogs[]): string[] {
  const over = workspaceLogs.filter((w) => w.trimBytes > 0);
  if (!over.length) return [];
  const total = workspaceLogs.reduce((n, w) => n + w.bytes, 0);
  const lines = [
    `Workspace logs (${formatBytes(total)} in ${workspaceLogs.length} workspace${workspaceLogs.length === 1 ? '' : 's'}) - ${over.length} with a log over twice the 8 MiB cap:`,
  ];
  for (const w of over) {
    lines.push(`  ${formatBytes(w.bytes).padStart(10)}  ${w.projectRoot ?? w.dir}`);
    lines.push(
      w.willTrim
        ? `              would TRIM ${formatBytes(w.trimBytes)}: Metro, client and device logs keep their newest 8 MiB`
        : `              kept: ${w.keptReason}`,
    );
  }
  return lines;
}

function leaseGarbageLines({ expired, kept }: DeviceLeaseGarbage): string[] {
  const lines: string[] = [];
  if (expired.length) {
    lines.push(`Expired device leases (${expired.length}) - the device is already free:`);
    for (const entry of expired) {
      const name = entry.lease?.deviceName ? ` (${entry.lease.deviceName})` : '';
      lines.push(`  ${entry.platform} ${entry.id ?? entry.name}${name}`);
      lines.push(
        `              held by ${entry.lease?.holder ?? 'an unrecorded workspace'} until ${entry.lease?.expiresAt}`,
      );
    }
    lines.push('              --delete removes the FILE only; an expired lease already holds nothing.');
  }
  if (kept.length) {
    lines.push(`Device lease files kept (${kept.length}) - reported, never deleted:`);
    for (const entry of kept) lines.push(`  ${entry.name}: ${entry.reason}`);
  }
  return lines;
}

function deviceSizeSuffix(device: { kind: 'ios' | 'android'; bytes?: number }): string {
  return device.bytes !== undefined ? ` - ${formatBytes(device.bytes)} on disk` : '';
}

function namedPortLines(ports: NonNullable<GcReport['orphanedPorts']> = []): string[] {
  if (!ports.length) return [];
  return [
    `Orphaned named ports (${ports.length}):`,
    ...ports.map(({ project, label, port }) => `  ${project}: ${label} (${port})`),
    '              --delete releases these allocations without stopping listeners.',
  ];
}

function orphanedWorkspaceLines(orphaned: readonly OrphanedWorkspace[]): string[] {
  if (!orphaned.length) return [];
  const lines = [`Orphaned workspace directories (${orphaned.length}):`];
  for (const entry of orphaned) {
    lines.push(`  ${entry.dir}${entry.bytes === undefined ? '' : ` - ${sizeText(entry.bytes)}`}`);
    lines.push(`              recorded project root ${entry.projectRoot} is gone and no registry entry names it`);
  }
  lines.push('              --delete re-checks each directory, then removes it whole.');
  return lines;
}

function workspaceOutputLines(outputs: WorkspaceOutputsReport, bytes: number): string[] {
  const lines = [
    `  ${formatBytes(bytes).padStart(10)}  Workspace build outputs (detected)`,
    `              ${outputs.root}`,
    `              ${WORKSPACE_OUTPUT_DIRS.join(', ')}, macOS Swift scratch and staged app bundles of each workspace, and the git-ignored in-tree build directories of its project; workspace.json, state.json, logs and device records stay`,
    `              ${REBUILD_COST}`,
  ];
  for (const w of outputs.workspaces) {
    const idle = w.idleDays === null ? 'last use unknown' : `idle ${w.idleDays}d`;
    lines.push(`    ${sizeText(w.bytes).padStart(8)}  ${w.projectRoot ?? w.dir} (${idle})`);
    if (w.inTreeDirs.length) lines.push(`                with ${w.inTreeDirs.join(', ')}`);
    lines.push(w.willClear ? '                would be LIGHTENED' : `                kept: ${w.keptReason}`);
  }
  return lines;
}

function cacheLines(caches: readonly GcCache[], workspaceOutputs: WorkspaceOutputsReport | null): string[] {
  const lines: string[] = [];
  const outputs = workspaceOutputs?.workspaces.length ? workspaceOutputs : null;
  if (caches.length || outputs) {
    const outputBytes = outputs ? outputs.workspaces.reduce((n, w) => n + (w.bytes ?? 0), 0) : 0;
    const total = caches.reduce((n, c) => n + (c.bytes ?? 0), 0) + outputBytes;
    lines.push(`Shared build caches (${caches.length + (outputs ? 1 : 0)}) - alive, not garbage:`);
    if (outputs) lines.push(...workspaceOutputLines(outputs, outputBytes));
    for (const c of caches) {
      const tag = c.source ? ` (${c.source})` : '';
      lines.push(`  ${sizeText(c.bytes ?? null).padStart(10)}  ${c.name}${tag}`);
      lines.push(`              ${c.dir}`);
      if (c.note) lines.push(`              ${c.note}`);
      if (c.sizeError) lines.push(`              ${c.sizeError}`);
      if (c.willEmpty) lines.push('              would be EMPTIED');
      else if (c.emptySkipped) lines.push(`              would be left alone: ${c.emptySkipped}`);
      else if (c.scopedEmpty?.emptySkipped) {
        lines.push(`              --delete --cache would leave it alone: ${c.scopedEmpty.emptySkipped}`);
      }
    }
    const incomplete = caches.some((c) => c.bytes === undefined) || outputs?.workspaces.some((w) => w.bytes === null);
    lines.push(`  total: ${incomplete ? 'at least ' : ''}${formatBytes(total)}`);
    const doomed = caches.filter((c) => c.willEmpty);
    if (doomed.length) {
      const doomedBytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
      lines.push(
        `  would empty ${doomed.length} of these (${doomed.some((c) => c.bytes === undefined) ? 'at least ' : ''}${formatBytes(doomedBytes)})`,
      );
    }
    const clearing = outputs?.workspaces.filter((w) => w.willClear) ?? [];
    if (clearing.length) {
      const clearBytes = clearing.reduce((n, w) => n + (w.bytes ?? 0), 0);
      lines.push(
        `  would lighten ${clearing.length} workspace${clearing.length === 1 ? '' : 's'}, freeing ${formatBytes(clearBytes)} of build outputs`,
      );
    }
  }
  return lines;
}

const BUILD_STATE_DIRS_SHOWN = 4;

function buildStateLine(state: WorktreeBuildState | undefined): string | null {
  if (!state?.dirs.length) return null;
  const shown = state.dirs.slice(0, BUILD_STATE_DIRS_SHOWN).map((dir) => `${dir.path} ${sizeText(dir.bytes)}`);
  const more = state.dirs.length > BUILD_STATE_DIRS_SHOWN ? ', ...' : '';
  return `              in-tree build state ${sizeText(state.bytes)}: ${shown.join(', ')}${more}`;
}

function unlistedWorktreeLines(sweep: WorktreeSweep | null): string[] {
  const unlisted = sweep?.unlisted ?? [];
  if (!unlisted.length) return [];
  const lines = [
    `Directories under .worktrees that git does not list as worktrees (${unlisted.length}) - reported, never removed:`,
  ];
  for (const dir of unlisted) {
    lines.push(`  ${dir.path} (${sizeText(dir.bytes)})`);
    lines.push(`              ${unlistedWorktreeDetail(dir)}`);
  }
  return lines;
}

function unlistedWorktreeDetail(dir: UnlistedWorktreeDir): string {
  return `git worktree list in ${dir.repository} does not show it, so gc cannot tell whether it holds work; look through it, then remove it with \`${unlistedWorktreeRemedy(dir)}\``;
}

function unlistedWorktreeRemedy(dir: UnlistedWorktreeDir): string {
  return `rm -rf '${dir.path.replaceAll("'", "'\\''")}'`;
}

function worktreeSweepLines(sweep: WorktreeSweep | null): string[] {
  if (!sweep || (!sweep.idle && !sweep.worktrees.length)) return [];
  const removable = sweep.worktrees.filter((w) => !w.skipped);
  const idle = !sweep.idle
    ? ''
    : sweep.idle.defaulted
      ? `, or clean, pushed and idle ${sweep.idle.olderThan}d or more (the default without --older-than)`
      : `, or clean, pushed and idle ${sweep.idle.olderThan}d or more`;
  const lines = [
    `Linked worktrees (${removable.length} removable, ${sweep.worktrees.length - removable.length} kept) - clean and merged into the default branch, or with a merged or closed pull request${idle}:`,
  ];
  const unknown = new Set(
    sweep.worktrees.flatMap((w) =>
      w.pullRequest && 'unavailable' in w.pullRequest ? [w.pullRequest.unavailable] : [],
    ),
  );
  for (const reason of unknown)
    lines.push(`  Pull request state unknown (${reason}); merges are judged from git alone.`);
  for (const w of sweep.worktrees) {
    const age = w.idleDays === null ? '' : ` (idle ${w.idleDays}d)`;
    lines.push(`  ${w.path}${age}`);
    const buildState = buildStateLine(w.buildState);
    if (buildState) lines.push(buildState);
    const note = worktreePullRequestNote(w);
    lines.push(
      w.skipped
        ? `              kept: ${w.skipped}${note && !w.skipped.includes(note) ? ` (${note})` : ''}`
        : `              would be REMOVED by \`stim worktree remove\`: ${worktreeRemovalReason(w, sweep)}`,
    );
  }
  if (removable.length) {
    lines.push(
      '              --delete runs it without --force; use, idleness and HEAD are re-checked under its removal locks.',
    );
  }
  return lines;
}

interface GcJsonLock {
  path: string;
  platform: string;
  key: string | null;
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

/** The `gc --json` sections, in text report order. Sections contain entries or a report-only usage payload. */
export interface GcJsonSections {
  archived?: ArchiveSelection['records'];
  archiveStaging?: ArchiveSelection['staging'];
  deadProjects: { path: string }[];
  invalidProjects: { path: string }[];
  orphanedPorts: { project: string; label: string; port: number }[];
  orphanedWorkspaces: { dir: string; projectRoot: string; bytes: number | null }[];
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
  orphanedDevices: {
    kind: 'ios' | 'android';
    id: string;
    name: string;
    bytes: number | null;
    directory: string | null;
  }[];
  unverifiedDevices: { kind: 'ios' | 'android'; id: string; name: string; command: string }[];
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
  staleStatusCaches: { kind: 'disk-usage' | 'pull-request'; path: string; file: string; bytes: number }[];
  idleDevices: IdleDevice[];
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
  worktreeDependencies: { path: string; willDelete: boolean; detail: string | null }[];
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
  archives,
  skipped = [],
  deadProjects = [],
  orphanedPorts = [],
  invalidProjects = [],
  orphanedWorkspaces = [],
  worktreeSweep = null,
  parkedSims = [],
  parkedAvds = [],
  parkedHostedDevices = [],
  orphanedDevices = [],
  unverifiedDevices = [],
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
  idleDevices = [],
  deviceSweepNotices = [],
  easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
  workspaceOutputs = null,
  workspaceLogs = [],
  worktreeDependencies = null,
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
    ...(archives ? { archived: archives.records, archiveStaging: archives.staging } : {}),
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
    idleDevices: idleDevices.map(({ kind, id, name, project, slot, lastActivityAt, idleForMs, buildInProgress }) => ({
      kind,
      id,
      name,
      project,
      slot,
      lastActivityAt,
      idleForMs,
      buildInProgress,
    })),
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
    worktreeDependencies: [
      ...(worktreeDependencies?.candidates ?? []).map(({ path }) => ({ path, willDelete: true, detail: null })),
      ...(worktreeDependencies?.skips ?? []).map(({ target, reason }) => ({
        path: target,
        willDelete: false,
        detail: reason,
      })),
    ],
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
