import { resolve, sep } from 'node:path';
import type { CensusFind, DiscoveryCensusFile, DiscoveryScanFile, ScanTruncation } from '@stim-cli/core/state';

const DAY_MS = 24 * 60 * 60_000;

export const DISCOVER_ROOTS_KEY = 'maintenance.discoverRoots';

// @ref LLP 0004#the-doctor-listing-and-the-low-disk-line -- the daemon measures, commands read
/** One folder of checkouts Stim does not fully manage, and what adopting it would take. */
interface UnmanagedGroup {
  folder: string;
  /** `reduce-only`: Stim reduces their build output and never removes them. `dot-folder`: Stim does nothing with them. */
  kind: 'reduce-only' | 'dot-folder';
  checkouts: number;
  /** The bytes of the build directories that were measured; a lower bound while `failed` or `notMeasuredYet` is above 0. */
  bytes: number;
  /** Checkouts whose every build directory was measured. */
  measured: number;
  /** Checkouts with a build directory that was tried and could not be measured in time. */
  failed: number;
  /** Checkouts the daemon has not measured yet, wholly or in part. */
  notMeasuredYet: number;
  /** The command that adds `folder` to the machine's `maintenance.discoverRoots`; null with `commandProblem` set. */
  command: string | null;
  commandProblem: 'too-broad' | 'setting-unreadable' | null;
  /** Reduce-only checkouts idle at least `idleAfterDays` that nothing uses, for the person to delete; never `dot-folder`. */
  idle: Array<{ path: string; idleDays: number }>;
}

type ScanSummary =
  | {
      status: 'read';
      ranAt: number;
      trigger: 'weekly' | 'low-disk';
      truncation: ScanTruncation;
      visited: number;
      unreadable: string[];
    }
  | { status: 'absent' | 'unreadable' | 'unusable' };

/** The doctor listing, from the two files the daemon wrote and the settings. It reads and walks nothing. */
export interface DiscoveryReport {
  scan: ScanSummary;
  /** `none`: no scan result, so no census is expected. */
  census: 'read' | 'absent' | 'unreadable' | 'unusable' | 'none';
  /** When the daemon last classified and measured the finds, epoch ms. */
  censusAt: number | null;
  /** `maintenance.olderThanDays` when idle checkouts are listed; null when it is 0 or does not read. */
  idleAfterDays: number | null;
  groups: UnmanagedGroup[];
}

export interface DiscoverRootsValue {
  value: unknown;
  error: string | null;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

/** The `maintenance.discoverRoots` entries as absolute paths, a leading `~` expanded; empty when the value does not read. */
export function rootsOf(setting: DiscoverRootsValue, home: string): string[] {
  if (setting.error || !isStrings(setting.value)) return [];
  return setting.value.map((entry) => resolve(expandHome(entry, home))).toSorted();
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The command that adds `folder` to the machine's roots, or null when the current value does not read. */
export function adoptCommand(setting: DiscoverRootsValue, folder: string): string | null {
  if (setting.error || !isStrings(setting.value)) return null;
  return `stim settings set ${DISCOVER_ROOTS_KEY} ${shellQuote(JSON.stringify([...setting.value, folder]))} --scope machine`;
}

function groupOf(
  first: CensusFind,
  finds: readonly CensusFind[],
  setting: DiscoverRootsValue,
  idleAfterDays: number | null,
  now: number,
): UnmanagedGroup {
  let bytes = 0;
  let measured = 0;
  let failed = 0;
  let notMeasuredYet = 0;
  const idle: UnmanagedGroup['idle'] = [];
  for (const find of finds) {
    bytes += find.bytes;
    if (find.evaluatedAt === 0 || (find.failedDirs === 0 && find.measuredDirs < find.dirs)) notMeasuredYet++;
    else if (find.failedDirs > 0) failed++;
    else measured++;
    if (find.kind === 'reduce-only' && idleAfterDays !== null && find.lastActivityAt !== null) {
      const idleDays = Math.floor((now - find.lastActivityAt) / DAY_MS);
      if (idleDays >= idleAfterDays) idle.push({ path: find.path, idleDays });
    }
  }
  const command = first.adoptable ? adoptCommand(setting, first.folder) : null;
  return {
    folder: first.folder,
    kind: first.kind,
    checkouts: finds.length,
    bytes,
    measured,
    failed,
    notMeasuredYet,
    command,
    commandProblem: !first.adoptable ? 'too-broad' : command === null ? 'setting-unreadable' : null,
    idle: idle.toSorted((a, b) => b.idleDays - a.idleDays),
  };
}

/**
 * The listing for doctor and the low-disk line. The census is the daemon's classification as of its last run, so a find
 * whose folder `maintenance.discoverRoots` names now is left out, and the listing is cut to what is still unmanaged.
 */
export function discoveryReport({
  scan,
  census,
  setting,
  idleAfterDays,
  home,
  now,
}: {
  scan: DiscoveryScanFile;
  census: DiscoveryCensusFile;
  setting: DiscoverRootsValue;
  idleAfterDays: number | null;
  home: string;
  now: number;
}): DiscoveryReport {
  const summary: ScanSummary =
    scan.status === 'read'
      ? scan.scan
        ? {
            status: 'read',
            ranAt: scan.scan.ranAt,
            trigger: scan.scan.trigger,
            truncation: scan.scan.truncation,
            visited: scan.scan.visited,
            unreadable: scan.scan.unreadable,
          }
        : { status: 'unusable' }
      : { status: scan.status };
  const base = { scan: summary, idleAfterDays, groups: [] };
  if (summary.status !== 'read') return { ...base, census: 'none', censusAt: null };
  if (census.status !== 'read') return { ...base, census: census.status, censusAt: null };
  if (!census.census) return { ...base, census: 'unusable', censusAt: null };
  const roots = new Set(rootsOf(setting, home));
  const byFolder = new Map<string, { first: CensusFind; finds: CensusFind[] }>();
  for (const find of census.census.finds) {
    if (roots.has(find.folder)) continue;
    const key = `${find.kind}\0${find.folder}`;
    const group = byFolder.get(key) ?? { first: find, finds: [] };
    group.finds.push(find);
    byFolder.set(key, group);
  }
  const groups = [...byFolder.values()]
    .map(({ first, finds }) => groupOf(first, finds, setting, idleAfterDays, now))
    .toSorted((a, b) => (a.kind === b.kind ? b.bytes - a.bytes : a.kind === 'reduce-only' ? -1 : 1));
  return { scan: summary, census: 'read', censusAt: census.census.at, idleAfterDays, groups };
}

const gb = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

const shorten = (path: string, home: string): string =>
  path === home ? '~' : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

function sizeText(group: UnmanagedGroup): string {
  const unknown = group.failed + group.notMeasuredYet;
  if (group.checkouts === unknown && group.bytes === 0) return 'build output not measured';
  const prefix = unknown ? 'at least ' : '';
  const rest = [
    group.failed ? `${count(group.failed, 'checkout')} could not be measured in time` : '',
    group.notMeasuredYet ? `${count(group.notMeasuredYet, 'checkout')} not measured yet` : '',
  ].filter(Boolean);
  return `${prefix}${gb(group.bytes)} of build output${rest.length ? ` (${rest.join(', ')})` : ''}`;
}

/** The doctor lines for the listing; empty when there is nothing to say. */
export function discoveryLines(report: DiscoveryReport, home: string): string[] {
  const { scan } = report;
  if (scan.status !== 'read')
    return [
      {
        absent: 'The daemon has not scanned the home folder yet; it scans about weekly and when the disk is low.',
        unreadable: 'The home folder scan result cannot be read, so Stim does not know what the scan found.',
        unusable:
          'The home folder scan result is unusable (corrupt or from another Stim version); the next scan replaces it.',
      }[scan.status],
    ];
  const when = `The daemon last scanned the home folder on ${day(scan.ranAt)} (${scan.trigger}), ${count(scan.visited, 'folder')} read.`;
  const cut =
    scan.truncation === 'none'
      ? ''
      : scan.truncation === 'failed'
        ? ' That scan failed, so it shows the finds of the earlier one.'
        : ` That scan stopped early (${{ budget: 'time budget', folders: 'folder limit', read: 'a read that did not answer' }[scan.truncation]}), so it may have missed checkouts.`;
  const unread = scan.unreadable.length
    ? ` It could not read ${scan.unreadable.map((path) => shorten(path, home)).join(', ')}.`
    : '';
  const lines = [`${when}${cut}${unread}`];
  if (report.census === 'absent') return [...lines, 'The daemon has not yet listed and measured what it found.'];
  if (report.census === 'unreadable')
    return [...lines, 'The list of what it found cannot be read, so Stim does not know what is unmanaged.'];
  if (report.census === 'unusable')
    return [
      ...lines,
      'The list of what it found is unusable (corrupt or from another Stim version); the daemon rewrites it.',
    ];
  if (!report.groups.length) return [...lines, 'Every checkout it found is managed.'];
  if (report.censusAt !== null)
    lines.push(`Listed and measured by the daemon on ${day(report.censusAt)}; commands never walk the disk.`);
  for (const group of report.groups) {
    lines.push('');
    lines.push(`${shorten(group.folder, home)}: ${count(group.checkouts, 'checkout')}, ${sizeText(group)}`);
    lines.push(
      group.kind === 'reduce-only'
        ? '  Stim reduces their build output when idle and never removes them. Adding the folder to maintenance.discoverRoots applies the full discovered-checkout rules, which include removing finished linked worktrees:'
        : '  Under a home dot-folder, where Stim cannot tell a checkout from an installed tool, so it does nothing with them. Adding the folder to maintenance.discoverRoots lets Stim reduce their build output and, for linked worktrees, remove finished ones:',
    );
    lines.push(
      group.command
        ? `  ${group.command}`
        : group.commandProblem === 'too-broad'
          ? '  This folder is the home folder or holds it, which maintenance.discoverRoots cannot name.'
          : '  maintenance.discoverRoots does not read, so no command is offered; fix it with stim settings first.',
    );
    for (const { path, idleDays } of group.idle)
      lines.push(
        `  Idle for at least ${count(idleDays, 'day')} and nothing uses it: ${shorten(path, home)}. Stim never removes it; delete it yourself if you no longer need it.`,
      );
  }
  return lines;
}

/**
 * The extra line of the low-disk warning: how much the unmanaged checkouts hold and the one command that adds the largest
 * reduce-only folder. Null when no checkout has a measured build directory. Dot-folder finds count toward the total but
 * are never the one named, since adopting them gives a tool home the full discovered rules.
 */
export function lowDiskLine(report: DiscoveryReport, home: string): string | null {
  const total = report.groups.reduce((sum, group) => sum + group.bytes, 0);
  const measuring = report.groups.some((group) => group.failed + group.notMeasuredYet > 0);
  if (total === 0) return null;
  const largest = report.groups.find((group) => group.kind === 'reduce-only' && group.command && group.bytes > 0);
  const holding = `Stim: checkouts it does not fully manage hold ${measuring ? 'at least ' : ''}${gb(total)} of build output`;
  if (!largest?.command) return `${holding}; stim doctor lists them.`;
  return `${holding}. Add the largest folder, ${shorten(largest.folder, home)} (${gb(largest.bytes)}), to what Stim manages with: ${largest.command}; stim doctor lists the rest.`;
}
