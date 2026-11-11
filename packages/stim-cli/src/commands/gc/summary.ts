import { formatBytes } from '../../fs-util.ts';
import { claimRemoveCommand } from '../../ownership-claim.ts';
import { shortUdid } from '../../command-output.ts';
import { unverifiedDeviceCommand } from './devices.ts';
import { ownedDeviceDiskLines } from './finished-devices.ts';
import { scopeLine, type GcReport } from './report.ts';

interface SummaryItem {
  label: string;
  bytes: number | null;
}

interface AttentionItem {
  label: string;
  remedies?: string[];
}

const LARGEST_SHOWN = 3;

function sizeOf(items: readonly SummaryItem[]): string {
  const known = items.filter((item) => item.bytes !== null);
  if (!known.length) return '';
  const total = formatBytes(known.reduce((sum, item) => sum + (item.bytes ?? 0), 0));
  return known.length === items.length ? total : `at least ${total}`;
}

function totalBytes(groups: readonly (readonly SummaryItem[])[]): number {
  return groups.flat().reduce((sum, item) => sum + (item.bytes ?? 0), 0);
}

function groupLines(title: string, items: readonly SummaryItem[]): string[] {
  const size = sizeOf(items);
  const largest = items.toSorted((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)).slice(0, LARGEST_SHOWN);
  const lines = [`  ${title} (${items.length}${size ? `, ${size}` : ''}):`];
  for (const item of largest) lines.push(`    ${item.bytes === null ? '' : `${formatBytes(item.bytes)}  `}${item.label}`);
  if (items.length > largest.length) lines.push(`    and ${items.length - largest.length} more`);
  return lines;
}

function countBy<T>(entries: readonly T[], key: (entry: T) => string): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${count} ${name}`).join(', ');
}

function reclaimGroups(report: Partial<GcReport>): [string, SummaryItem[]][] {
  const scoped = Boolean(report.cacheScope);
  const ladderLevel = report.ladder?.levels.find((level) => level.level === report.ladderRun);
  const groups: [string, SummaryItem[]][] = [
    ['Archived workspaces', (report.archives?.records ?? []).filter((r) => r.willDelete).map((r) => ({ label: r.id, bytes: r.bytes }))],
    ['Dead project entries', (report.deadProjects ?? []).map((path) => ({ label: path, bytes: null }))],
    ['Invalid project entries', (report.invalidProjects ?? []).map((path) => ({ label: path, bytes: null }))],
    [
      'Orphaned named ports',
      (report.orphanedPorts ?? []).map((p) => ({ label: `${p.project}: ${p.label} (${p.port})`, bytes: null })),
    ],
    [
      'Orphaned workspace directories',
      (report.orphanedWorkspaces ?? []).map((w) => ({ label: w.dir, bytes: w.bytes ?? null })),
    ],
    [
      'Linked worktrees to remove',
      (report.worktreeSweep?.worktrees ?? [])
        .filter((w) => !w.skipped)
        .map((w) => ({ label: w.path, bytes: w.buildState?.bytes ?? null })),
    ],
    [
      scoped ? 'Parked simulators to erase' : 'Parked simulators',
      (report.parkedSims ?? []).map((s) => ({ label: `${s.name} (${shortUdid(s.udid)})`, bytes: s.bytes })),
    ],
    [
      scoped ? 'Parked emulators to erase' : 'Parked emulators',
      (report.parkedAvds ?? []).map((a) => ({ label: a.name, bytes: a.bytes })),
    ],
    [
      'Parked hosted devices',
      (report.parkedHostedDevices ?? [])
        .filter((d) => d.listed !== false)
        .map((d) => ({ label: `${d.platform} ${d.name ?? 'unknown device'} (session ${d.session})`, bytes: null })),
    ],
    [
      'Orphaned devices',
      (report.orphanedDevices ?? []).map((d) => ({ label: `${d.kind} ${d.name} (${d.id})`, bytes: d.bytes ?? null })),
    ],
    [
      'Stale owned devices',
      (report.staleDevices ?? []).map((d) => ({ label: `${d.kind} ${d.name} (${d.id})`, bytes: d.bytes ?? null })),
    ],
    [
      'Devices of finished worktrees',
      (report.finishedDevices ?? []).map((d) => ({ label: `${d.kind} ${d.name} (${d.id})`, bytes: d.bytes ?? null })),
    ],
    [
      'Stale device records',
      (report.staleDeviceRecords ?? []).map((r) => ({ label: `${r.kind} ${r.id}`, bytes: null })),
    ],
    [
      'Stale device ledger entries',
      (report.staleLedgerEntries ?? []).map((e) => ({ label: `${e.kind} ${e.id}`, bytes: null })),
    ],
    ['Stale EAS ledger entries', (report.staleEasLedgerEntries ?? []).map((e) => ({ label: e.id, bytes: null }))],
    [
      'Forgettable Stim homes',
      (report.otherHomes ?? []).filter((h) => h.forgettable).map((h) => ({ label: h.path, bytes: null })),
    ],
    [
      'Stale status cache entries',
      (report.staleStatusCaches ?? []).map((c) => ({ label: `${c.kind}: ${c.path}`, bytes: c.bytes })),
    ],
    ['Stale build locks', (report.buildLocks?.stale ?? []).map((l) => ({ label: l.path, bytes: null }))],
    ['Stale build slots', (report.buildSlots?.stale ?? []).map((s) => ({ label: s.path, bytes: null }))],
    [
      'Expired device leases',
      (report.deviceLeases?.expired ?? []).map((e) => ({ label: `${e.platform} ${e.id ?? e.name}`, bytes: null })),
    ],
    [
      'Orphaned EAS sessions',
      (report.easSessionSweep?.orphaned ?? []).map((s) => ({ label: `${s.name} (${s.id})`, bytes: null })),
    ],
    [
      'Workspace logs to trim',
      (report.workspaceLogs ?? [])
        .filter((w) => w.willTrim)
        .map((w) => ({ label: w.projectRoot ?? w.dir, bytes: w.trimBytes })),
    ],
    [
      'Device recordings',
      (report.recordings ?? [])
        .filter((r) => r.willDelete && !r.withWorkspace)
        .map((r) => ({ label: r.projectRoot ?? r.dir, bytes: r.deleteBytes })),
    ],
    [
      'Caches to empty',
      (report.caches ?? []).filter((c) => c.willEmpty).map((c) => ({ label: c.name, bytes: c.bytes ?? null })),
    ],
    [
      'Workspace build outputs to lighten',
      scoped
        ? (report.workspaceOutputs?.workspaces ?? [])
            .filter((w) => w.willClear)
            .map((w) => ({ label: w.projectRoot ?? w.dir, bytes: w.bytes }))
        : [],
    ],
    [
      'TMPDIR leftovers',
      (report.tempLeftovers?.entries ?? []).filter((e) => e.willDelete).map((e) => ({ label: e.path, bytes: e.bytes })),
    ],
    [
      'Worktree trash',
      (report.trash?.entries ?? []).filter((e) => e.willDelete).map((e) => ({ label: e.path, bytes: e.bytes })),
    ],
    [
      'Gradle versions',
      (report.gradleVersions?.versions ?? [])
        .filter((v) => v.willDelete)
        .map((v) => ({ label: v.version, bytes: v.bytes })),
    ],
    [
      'Helper processes to stop',
      (report.memory?.processes ?? [])
        .filter((p) => p.reclaimable)
        .map((p) => ({ label: `${p.kind} pid ${p.pid}`, bytes: p.bytes })),
    ],
    [
      'Watchman roots to drop',
      (report.memory?.watchmanRoots ?? []).filter((r) => r.removable).map((r) => ({ label: r.path, bytes: null })),
    ],
    [
      `Pressure ladder at ${report.ladderRun ?? 'high'}`,
      (ladderLevel?.actions ?? []).map((a) => ({ label: `${a.kind.replaceAll('-', ' ')} ${a.target}`, bytes: a.bytes })),
    ],
  ];
  return groups.filter(([, items]) => items.length > 0);
}

function attentionGroups(report: Partial<GcReport>): [string, AttentionItem[]][] {
  const unresolved = [...(report.buildLocks?.unresolved ?? []), ...(report.buildSlots?.unresolved ?? [])];
  const groups: [string, AttentionItem[]][] = [
    [
      'Unrecognized stim-* devices, not deleted because this Stim home has no record of creating them',
      (report.unverifiedDevices ?? []).map((d) => ({
        label: `${d.kind} ${d.name} (${d.id})`,
        remedies: [unverifiedDeviceCommand(d)],
      })),
    ],
    [
      'Build locks and slots Stim cannot resolve; run the command once nothing builds with it',
      unresolved.map((entry) => ({ label: entry.path, remedies: [claimRemoveCommand(entry.path)] })),
    ],
    [
      'Directories under .worktrees that git does not list; look through each before removing it',
      (report.worktreeSweep?.unlisted ?? []).map((dir) => ({
        label: dir.path,
        remedies: [`rm -rf '${dir.path.replaceAll("'", "'\\''")}'`],
      })),
    ],
    [
      'Other Stim homes; this home never changes them or their devices',
      (report.otherHomes ?? []).map((home) => ({
        label: `${home.path} (${home.state}, ${home.workspaces} workspace${home.workspaces === 1 ? '' : 's'}, ${home.devices.length} device${home.devices.length === 1 ? '' : 's'})`,
        remedies: home.teardown,
      })),
    ],
    [
      'Device lease files kept',
      (report.deviceLeases?.kept ?? []).map((entry) => ({ label: `${entry.name}: ${entry.reason}` })),
    ],
    [
      'Entries not classified as dead',
      (report.skipped ?? []).map((entry) => ({ label: `${entry.dir}: ${entry.reason}` })),
    ],
    ['Device sweep notices', (report.deviceSweepNotices ?? []).map((label) => ({ label }))],
    ['EAS session sweep notices', (report.easSessionSweep?.notices ?? []).map((label) => ({ label }))],
    ['Memory notices', (report.memory?.notices ?? []).map((label) => ({ label }))],
    ['Automatic maintenance blocked', (report.maintenance?.blocked ?? []).map((label) => ({ label }))],
    [
      'Gradle version sweep blocked',
      report.gradleVersions?.blocked ? [{ label: report.gradleVersions.blocked.detail }] : [],
    ],
  ];
  return groups.filter(([, items]) => items.length > 0);
}

function reportOnlyLines(report: Partial<GcReport>): string[] {
  const lines: string[] = [];
  const folders = report.simulatorLaunchdFolders ?? [];
  if (folders.length) {
    const size = sizeOf(folders);
    lines.push(
      `  Simulator launchd folders with no simulator: ${folders.length}${size ? `, ${size}` : ''}; rm -rf a folder once its simulator is gone for good`,
    );
  }
  const live = report.buildLocks?.live ?? [];
  if (live.length) lines.push(`  Builds in progress: ${live.length}, not touched`);
  const kept = (report.worktreeSweep?.worktrees ?? []).filter((w) => w.skipped);
  if (kept.length) lines.push(`  Linked worktrees kept: ${countBy(kept, (w) => w.skipCode ?? 'other')}`);
  const caches = (report.caches ?? []).filter((c) => !c.willEmpty);
  if (caches.length) lines.push(`  Shared build caches, alive: ${caches.length}, ${sizeOf(caches.map((c) => ({ label: c.name, bytes: c.bytes ?? null }))) || 'size unknown'}`);
  lines.push(...ownedDeviceDiskLines(report.ownedDeviceDisk).map((line) => `  ${line}`));
  const recordings = (report.recordings ?? []).filter((r) => !r.willDelete);
  if (recordings.length) {
    lines.push(
      `  Device recordings kept: ${recordings.length}, ${formatBytes(recordings.reduce((sum, r) => sum + r.bytes, 0))}`,
    );
  }
  const tempKept = (report.tempLeftovers?.entries ?? []).filter((e) => !e.willDelete);
  if (tempKept.length) {
    lines.push(
      `  TMPDIR leftovers kept: ${tempKept.length}, ${formatBytes(tempKept.reduce((sum, e) => sum + e.bytes, 0))}`,
    );
  }
  if (report.swiftpmCacheUsage?.present && report.swiftpmCacheUsage.bytes !== null)
    lines.push(`  SwiftPM cache: ${formatBytes(report.swiftpmCacheUsage.bytes)}, never deleted`);
  if (report.agentDeviceUsage) lines.push(`  agent-device state: ${formatBytes(report.agentDeviceUsage.bytes)}, never deleted`);
  if (report.machineCaches) lines.push("  Other tools' machine-wide caches: sizes and remedies are in the full report");
  if (report.hostedAppStorage?.length) lines.push(`  Hosted app storage areas: ${report.hostedAppStorage.length}`);
  const maintenance = report.maintenance;
  if (maintenance) {
    const bytes = maintenance.actions.reduce((sum, action) => sum + action.bytes, 0);
    lines.push(
      `  Automatic maintenance (${maintenance.mode === 'report' ? 'report only' : maintenance.mode}): ${maintenance.actions.length} action${maintenance.actions.length === 1 ? '' : 's'} planned (${formatBytes(bytes)}), ${maintenance.skips.length} kept`,
    );
  }
  const ladder = report.ladder;
  if (ladder) {
    const pressure = `${ladder.pressure.level}${ladder.pressure.reasons.length ? `; ${ladder.pressure.reasons.join('; ')}` : ''}`;
    lines.push(`  Pressure level now: ${pressure}`);
    for (const level of ladder.levels.filter((entry) => entry.level !== report.ladderRun)) {
      const bytes = level.actions.reduce((sum, action) => sum + action.bytes, 0);
      lines.push(`  \`${level.command}\` would run the ladder at ${level.level}: about ${formatBytes(bytes)}`);
    }
    if (ladder.workspaces.length) lines.push(`  Workspace stages: ${countBy(ladder.workspaces, (w) => w.stage)}`);
  }
  return lines;
}

/**
 * The plain-text `stim gc` report: what would be or is being reclaimed, by category with its largest entries, every
 * entry that needs a person, and one line per report-only section. The full report goes to the report file.
 */
export function formatGcSummary(report: Partial<GcReport>, deleting: boolean): string[] {
  const lines: string[] = report.cacheScope ? [scopeLine(report.cacheScope)] : [];
  const reclaim = reclaimGroups(report);
  const attention = attentionGroups(report);
  if (reclaim.length) {
    const count = reclaim.reduce((sum, [, items]) => sum + items.length, 0);
    const bytes = totalBytes(reclaim.map(([, items]) => items));
    lines.push(
      `${deleting ? 'Reclaiming' : '--delete would reclaim'} about ${formatBytes(bytes)} from ${count} entr${count === 1 ? 'y' : 'ies'}:`,
    );
    for (const [title, items] of reclaim) lines.push(...groupLines(title, items));
  } else {
    lines.push('Nothing to reclaim.');
  }
  if (attention.length) {
    lines.push('Needs a person:');
    for (const [title, items] of attention) {
      lines.push(`  ${title} (${items.length}):`);
      for (const item of items) {
        lines.push(`    ${item.label}`);
        for (const remedy of item.remedies ?? []) lines.push(`      ${remedy}`);
      }
    }
  }
  const reportOnly = reportOnlyLines(report);
  if (reportOnly.length) lines.push('Report only:', ...reportOnly);
  return lines;
}
