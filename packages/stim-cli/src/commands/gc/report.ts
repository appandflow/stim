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
import type { GcCache } from './caches.ts';
import {
  worktreePullRequestNote,
  worktreeRemovalReason,
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
import type { EasSessionSweep } from './eas-sessions.ts';
import { idleDeviceLines, type IdleDevice } from './idle.ts';

export interface GcReport {
  skipped: GcSkip[];
  deadProjects: string[];
  orphanedPorts?: { project: string; label: string; port: number }[];
  invalidProjects: string[];
  orphanedWorkspaces: OrphanedWorkspace[];
  parkedSims: ParkedSimReport[];
  parkedAvds: ParkedAvdReport[];
  orphanedDevices: OrphanedDevice[];
  unverifiedDevices: UnverifiedDevice[];
  staleDevices: StaleProjectDevice[];
  staleDeviceRecords: StaleDeviceRecord[];
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[]; unresolved?: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[]; unresolved?: BuildSlotInfo[] };
  deviceLeases: DeviceLeaseGarbage;
  idleDevices: IdleDevice[];
  deviceSweepNotices: string[];
  easSessionSweep: EasSessionSweep;
  caches: GcCache[];
  workspaceOutputs: WorkspaceOutputsReport | null;
  worktreeSweep?: WorktreeSweep | null;
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

function formatParkedSimReport(parkedSims: readonly ParkedSimReport[], now: number): string[] {
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
    lines.push(`  ios ${sim.name} (${shortUdid(sim.udid)})${model ? ` ${model}` : ''} ${age}${bytes}${gone}`);
  }
  lines.push('              --delete attempts verified deletions and keeps failures.');
  return lines;
}

function formatParkedAvdReport(parkedAvds: readonly ParkedAvdReport[], now: number): string[] {
  if (!parkedAvds.length) return [];
  const lines: string[] = [];
  lines.push(`Parked emulators (${parkedAvds.length}):`);
  for (const avd of parkedAvds) {
    const listed =
      avd.listed === false ? ' - not on this machine' : avd.listed === null ? ' - listing unavailable; kept' : '';
    lines.push(
      `  android ${avd.name} ${avd.systemImage}${avd.deviceProfile ? ` ${avd.deviceProfile}` : ''} ${parkedAge(avd.parkedAt, now)}${avd.bytes === null ? '' : ` ${formatBytes(avd.bytes)}`}${listed}`,
    );
  }
  lines.push('              --delete attempts verified deletions and keeps failures.');
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

export function formatGcReport(
  {
    skipped = [],
    deadProjects = [],
    orphanedPorts,
    invalidProjects = [],
    orphanedWorkspaces = [],
    parkedSims = [],
    parkedAvds = [],
    orphanedDevices = [],
    unverifiedDevices = [],
    staleDevices = [],
    staleDeviceRecords = [],
    buildLocks = { stale: [], live: [], unresolved: [] },
    buildSlots = { stale: [], live: [], unresolved: [] },
    deviceLeases = { expired: [], kept: [] },
    idleDevices = [],
    deviceSweepNotices = [],
    easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    caches = [],
    workspaceOutputs = null,
    worktreeSweep = null,
    cacheScope = null,
    olderThan = null,
  }: Partial<GcReport>,
  { now = Date.now() }: { now?: number } = {},
): string[] {
  const lines: string[] = [];
  const staleLocks = buildLocks?.stale ?? [];
  const liveLocks = buildLocks?.live ?? [];
  const staleSlots = buildSlots?.stale ?? [];
  const expiredLeases = deviceLeases?.expired ?? [];

  if (cacheScope) {
    lines.push(`Cache scope: "${cacheScope}". Devices, project entries and locks were not inspected.`);
  } else if (
    [
      deadProjects,
      invalidProjects,
      orphanedWorkspaces,
      parkedSims,
      parkedAvds,
      orphanedDevices,
      staleDevices,
      staleDeviceRecords,
      staleLocks,
      staleSlots,
      expiredLeases,
      easSessionSweep.orphaned,
      workspaceOutputs?.workspaces.filter((entry) => entry.willClear) ?? [],
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

  lines.push(...formatParkedSimReport(parkedSims, now));
  lines.push(...formatParkedAvdReport(parkedAvds, now));

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})${deviceSizeSuffix(d)}`);
  }

  if (unverifiedDevices.length) {
    lines.push(
      `Unrecognized stim-* devices (${unverifiedDevices.length}) - NOT deleted, because Stim has no record of creating them:`,
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

  lines.push(...idleDeviceLines(idleDevices));

  if (staleDeviceRecords.length) {
    lines.push(`Stale device records (${staleDeviceRecords.length}) - the device is gone, the project is not:`);
    for (const r of staleDeviceRecords) {
      lines.push(`  ${r.kind} ${r.id} is not on this machine`);
      lines.push(`              recorded by ${r.project}`);
    }
    lines.push('              --delete clears the RECORD only; there is no device left to touch.');
  }

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

  lines.push(...cacheLines(caches, workspaceOutputs));

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
  return device.kind === 'android' && device.bytes !== undefined ? ` - ${formatBytes(device.bytes)} on disk` : '';
}

function namedPortLines(ports: NonNullable<GcReport['orphanedPorts']> = []): string[] {
  if (!ports.length) return [];
  return [
    `Orphaned named ports (${ports.length}):`,
    ...ports.map(({ project, label, port }) => `  ${project}: ${label} (${port})`),
    '              --delete stops TCP listeners and releases these allocations.',
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
    `              ${WORKSPACE_OUTPUT_DIRS.join(', ')} of each workspace; workspace.json, state.json, logs and device records stay`,
    `              ${REBUILD_COST}`,
  ];
  for (const w of outputs.workspaces) {
    const idle = w.idleDays === null ? 'last use unknown' : `idle ${w.idleDays}d`;
    lines.push(`    ${sizeText(w.bytes).padStart(8)}  ${w.projectRoot ?? w.dir} (${idle})`);
    lines.push(w.willClear ? '                would be CLEARED' : `                kept: ${w.keptReason}`);
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
      lines.push(`  ${formatBytes(c.bytes ?? 0).padStart(10)}  ${c.name}${tag}`);
      lines.push(`              ${c.dir}`);
      if (c.note) lines.push(`              ${c.note}`);
      if (c.willEmpty) lines.push('              would be EMPTIED');
      else if (c.emptySkipped) lines.push(`              would be left alone: ${c.emptySkipped}`);
    }
    lines.push(`  total: ${formatBytes(total)}`);
    const doomed = caches.filter((c) => c.willEmpty);
    if (doomed.length) {
      const doomedBytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
      lines.push(`  would empty ${doomed.length} of these (${formatBytes(doomedBytes)})`);
    }
    const clearing = outputs?.workspaces.filter((w) => w.willClear) ?? [];
    if (clearing.length) {
      const clearBytes = clearing.reduce((n, w) => n + (w.bytes ?? 0), 0);
      lines.push(
        `  would clear the build outputs of ${clearing.length} workspace${clearing.length === 1 ? '' : 's'} (${formatBytes(clearBytes)})`,
      );
    }
  }
  return lines;
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
    const note = worktreePullRequestNote(w);
    lines.push(
      w.skipped
        ? `              kept: ${w.skipped}${note && !w.skipped.includes(note) ? ` (${note})` : ''}`
        : `              would be REMOVED by \`stim worktree remove\`: ${worktreeRemovalReason(w)}`,
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

/** The `gc --json` sections, in text report order. Each section is an array of entries. */
export interface GcJsonSections {
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
  }[];
  parkedSimulators: ParkedSimReport[];
  parkedEmulators: ParkedAvdReport[];
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
  staleDeviceRecords: { kind: 'ios' | 'android'; id: string; project: string; slot: string | null }[];
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
  workspaceBuildOutputs: {
    dir: string;
    projectRoot: string | null;
    bytes: number | null;
    idleDays: number | null;
    willClear: boolean;
    reason: WorkspaceKeptCode | null;
    detail: string | null;
  }[];
  caches: {
    name: string;
    dir: string;
    source: 'registered' | 'detected' | null;
    bytes: number | null;
    note: string | null;
    willEmpty: boolean;
    emptySkipped: string | null;
  }[];
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
  orphanedDevices = [],
  unverifiedDevices = [],
  staleDevices = [],
  staleDeviceRecords = [],
  buildLocks = { stale: [], live: [], unresolved: [] },
  buildSlots = { stale: [], live: [], unresolved: [] },
  deviceLeases = { expired: [], kept: [] },
  idleDevices = [],
  deviceSweepNotices = [],
  easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
  workspaceOutputs = null,
  caches = [],
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
    linkedWorktrees: (worktreeSweep?.worktrees ?? []).map((w) => ({
      path: w.path,
      idleDays: w.idleDays,
      mergedInto: w.merge?.merged ? w.merge.into : null,
      pullRequest: jsonPullRequest(w.pullRequest),
      pullRequestUnknown: w.pullRequest && 'unavailable' in w.pullRequest ? w.pullRequest.unavailable : null,
      willRemove: w.skipCode === null,
      reason: w.skipCode,
      detail: w.skipped ?? worktreeRemovalReason(w),
      eligibleAt: w.eligibleAt === null ? null : new Date(w.eligibleAt).toISOString(),
    })),
    parkedSimulators: parkedSims.map(({ udid, name, model, runtime, parkedAt, bytes, listed }) => ({
      udid,
      name,
      model,
      runtime,
      parkedAt,
      bytes,
      listed,
    })),
    parkedEmulators: parkedAvds.map(({ name, systemImage, deviceProfile, parkedAt, bytes, listed }) => ({
      name,
      systemImage,
      deviceProfile,
      parkedAt,
      bytes,
      listed,
    })),
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
    staleDeviceRecords: staleDeviceRecords.map((r) => ({
      kind: r.kind,
      id: r.id,
      project: r.project,
      slot: r.slot ?? null,
    })),
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
    workspaceBuildOutputs: (workspaceOutputs?.workspaces ?? []).map((w) => ({
      dir: w.dir,
      projectRoot: w.projectRoot,
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
    })),
  };
}
