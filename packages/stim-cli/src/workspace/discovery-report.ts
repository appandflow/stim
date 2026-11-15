import { resolve, sep } from 'node:path';
import type { CensusFind, DiscoveryCensusFile, DiscoveryScanFile, ScanTruncation } from '@stim-cli/core/state';

export const DISCOVER_ROOTS_KEY = 'maintenance.discoverRoots';

// @ref LLP 0004#the-doctor-listing-and-the-low-disk-line -- the daemon measures, commands read
/** One folder of checkouts Stim does not fully manage, and what adopting it would take. */
interface UnmanagedGroup {
  folder: string;
  /**
   * `reduce-only`: Stim reduces their build output and never removes them. `dot-folder`: Stim does nothing with them.
   * `unchecked`: a read did not answer, so whether they are still checkouts, and managed, is not known this time.
   */
  kind: 'reduce-only' | 'dot-folder' | 'unchecked';
  checkouts: number;
  /** The bytes of the build directories that were measured; a lower bound while `failed`, `partial` or `notMeasuredYet` is above 0, or the list is not `complete`. */
  bytes: number;
  /** Checkouts whose every build directory was measured. */
  measured: number;
  /** Checkouts with a build directory that was tried and could not be measured in time. */
  failed: number;
  /** Checkouts measured, but with a directory whose walk could not read everything: their bytes are a lower bound. */
  partial: number;
  /** Checkouts the daemon has not measured yet, wholly or in part. */
  notMeasuredYet: number;
  /** The command that adds `folder` to the machine's `maintenance.discoverRoots`; null with `commandProblem` set. */
  command: string | null;
  commandProblem: 'too-broad' | 'already-named' | 'setting-unreadable' | 'unchecked' | null;
  /**
   * Each checkout with when git last wrote in it (ISO time; null is unknown, never old), oldest first, unknown last. It
   * is the newest modification time of the git directory's HEAD, index and logs/HEAD, and says nothing about edits.
   */
  members: Array<{ path: string; gitActivityAt: string | null }>;
  /** The oldest measurement among the checkouts that have one, epoch ms; null when none was measured. */
  oldestMeasuredAt: number | null;
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
  /** Whether the census was made from the scan the scan file holds now; when false its sizes are not shown. */
  censusCurrent: boolean;
  /** `maintenance.discoverRoots` changed since the census classified, so the classification may be stale. */
  rootsChangedSinceCensus: boolean;
  /**
   * Whether the listing may be taken as everything the scan found: false when the scan stopped early, failed or could
   * not read a path, the census is not from the current scan, is still pending or predates a roots change, or any group
   * is unchecked or holds a failed, partial or not yet measured checkout. Every figure and the sentence that all is
   * managed follow this one value.
   */
  complete: boolean;
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

const KIND_ORDER = { 'reduce-only': 0, 'dot-folder': 1, unchecked: 2 };

function groupOf(
  first: CensusFind,
  finds: readonly CensusFind[],
  setting: DiscoverRootsValue,
  named: boolean,
): UnmanagedGroup {
  const unchecked = first.kind === 'unchecked';
  let bytes = 0;
  let measured = 0;
  let failed = 0;
  let notMeasuredYet = 0;
  let partial = 0;
  let oldestMeasuredAt: number | null = null;
  for (const find of finds) {
    bytes += find.bytes;
    if (find.evaluatedAt === 0 || (!find.unreadable && find.failedDirs === 0 && find.measuredDirs < find.dirs))
      notMeasuredYet++;
    else if (find.unreadable || find.failedDirs > 0) failed++;
    else {
      measured++;
      if (find.partialDirs > 0) partial++;
    }
    if (find.evaluatedAt > 0 && (oldestMeasuredAt === null || find.evaluatedAt < oldestMeasuredAt))
      oldestMeasuredAt = find.evaluatedAt;
  }
  const command = first.adoptable && !unchecked && !named ? adoptCommand(setting, first.folder) : null;
  return {
    folder: first.folder,
    kind: first.kind,
    checkouts: finds.length,
    bytes,
    measured,
    failed,
    partial,
    notMeasuredYet,
    command,
    commandProblem: unchecked
      ? 'unchecked'
      : !first.adoptable
        ? 'too-broad'
        : named
          ? 'already-named'
          : command === null
            ? 'setting-unreadable'
            : null,
    oldestMeasuredAt,
    members: finds
      .map((find) => ({ path: find.path, at: find.gitActivityAt }))
      .toSorted((a, b) =>
        a.at === null || b.at === null ? Number(a.at === null) - Number(b.at === null) : a.at - b.at,
      )
      .map(({ path, at }) => ({ path, gitActivityAt: at === null ? null : new Date(at).toISOString() })),
  };
}

/**
 * The listing for doctor and the low-disk line. The census is the daemon's classification as of its last run: it alone
 * decides what is listed, and this function never hides an entry, it only chooses how to present it. A group whose
 * folder is a root discovery uses (or the setting names now) is shown without an adopt command.
 */
export function discoveryReport({
  scan,
  census,
  setting,
  home,
  canonical,
}: {
  scan: DiscoveryScanFile;
  census: DiscoveryCensusFile;
  setting: DiscoverRootsValue;
  home: string;
  /**
   * Resolves symlinks of a configured root, which `stim doctor` may do. The per-command hook passes null and so makes no
   * filesystem call: it compares strings with the roots the census recorded, and lists nothing once the setting changed.
   */
  canonical: ((path: string) => string) | null;
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
  const base = { scan: summary, censusCurrent: false, rootsChangedSinceCensus: false, complete: false, groups: [] };
  if (summary.status !== 'read') return { ...base, census: 'none', censusAt: null };
  if (census.status !== 'read') return { ...base, census: census.status, censusAt: null };
  if (!census.census) return { ...base, census: 'unusable', censusAt: null };
  const lexical = rootsOf(setting, home);
  const recorded = census.census.roots;
  const unchanged = recorded.length === lexical.length && recorded.every((root, at) => root === lexical[at]);
  const roots = new Set([...lexical, ...census.census.canonicalRoots, ...(canonical ? lexical.map(canonical) : [])]);
  const current = summary.ranAt === census.census.scanRanAt;
  const byFolder = new Map<string, { first: CensusFind; finds: CensusFind[] }>();
  for (const listed of census.census.finds) {
    const find = current
      ? listed
      : {
          ...listed,
          evaluatedAt: 0,
          dirs: 0,
          measuredDirs: 0,
          failedDirs: 0,
          partialDirs: 0,
          bytes: 0,
          unreadable: false,
          gitActivityAt: null,
        };
    const key = `${find.kind}\0${find.folder}`;
    const group = byFolder.get(key) ?? { first: find, finds: [] };
    group.finds.push(find);
    byFolder.set(key, group);
  }
  const groups = [...byFolder.values()]
    .map(({ first, finds }) => groupOf(first, finds, setting, first.adoptable && roots.has(first.folder)))
    .toSorted((a, b) => (a.kind === b.kind ? b.bytes - a.bytes : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
  return {
    scan: summary,
    census: 'read',
    censusAt: census.census.at,
    censusCurrent: current,
    rootsChangedSinceCensus: !unchanged,
    complete:
      summary.truncation === 'none' &&
      summary.unreadable.length === 0 &&
      current &&
      !census.census.pending &&
      unchanged &&
      groups.every((group) => group.kind !== 'unchecked' && group.failed + group.partial + group.notMeasuredYet === 0),
    groups,
  };
}

const gb = (bytes: number): string =>
  bytes === 0
    ? '0 B'
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

const shorten = (path: string, home: string): string =>
  path === home ? '~' : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

function sizeText(group: UnmanagedGroup, complete: boolean): string {
  const unknown = group.failed + group.notMeasuredYet + group.partial;
  if (group.checkouts === unknown && group.bytes === 0) return 'build output not measured';
  const prefix = unknown || !complete ? 'at least ' : '';
  const rest = [
    group.failed ? `${count(group.failed, 'checkout')} could not be measured` : '',
    group.notMeasuredYet ? `${count(group.notMeasuredYet, 'checkout')} not measured yet` : '',
    group.partial ? `${count(group.partial, 'checkout')} partly read, so only a lower bound` : '',
  ].filter(Boolean);
  const age = group.oldestMeasuredAt === null ? [] : [`oldest measurement ${day(group.oldestMeasuredAt)}`];
  const notes = [...rest, ...age];
  return `${prefix}${gb(group.bytes)} of build output${notes.length ? ` (${notes.join(', ')})` : ''}`;
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
  if (!report.groups.length) {
    return [
      ...lines,
      report.complete
        ? 'Every checkout it found is managed.'
        : 'No unmanaged checkout is listed, but that scan or its list is incomplete, so checkouts may be missing.',
    ];
  }
  if (report.censusAt !== null)
    lines.push(`Listed and measured by the daemon on ${day(report.censusAt)}; commands never walk the disk.`);
  if (!report.censusCurrent)
    lines.push(
      'That list was made from an earlier scan than the last one, so its sizes are not shown until the daemon lists again.',
    );
  for (const group of report.groups) {
    lines.push('');
    if (group.kind === 'unchecked') {
      lines.push(
        `${shorten(group.folder, home)}: ${count(group.checkouts, 'checkout')} could not be checked this time because a read did not answer; they are neither listed as managed nor gone, and the daemon checks again within the hour. Any measurement below is from an earlier run.`,
      );
      lines.push(`  ${sizeText(group, report.complete)}`);
      for (const { path, gitActivityAt } of group.members)
        lines.push(
          `  ${shorten(path, home)}: last git activity ${gitActivityAt === null ? 'unknown' : gitActivityAt.slice(0, 10)}`,
        );
      continue;
    }
    lines.push(
      `${shorten(group.folder, home)}: ${count(group.checkouts, 'checkout')}, ${sizeText(group, report.complete)}`,
    );
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
          : group.commandProblem === 'already-named'
            ? '  This folder is already named in maintenance.discoverRoots, so there is nothing to add; these are listed because discovery did not select them or could not check them yet.'
            : '  maintenance.discoverRoots does not read, so no command is offered; fix it with stim settings first.',
    );
    for (const { path, gitActivityAt } of group.members)
      lines.push(
        `  ${shorten(path, home)}: last git activity ${gitActivityAt === null ? 'unknown' : gitActivityAt.slice(0, 10)}`,
      );
    if (group.kind === 'reduce-only')
      lines.push(
        '  Stim has not checked whether they are in use or hold uncommitted or unpushed work; last git activity is when git last wrote there and says nothing about edits made without it; delete a checkout you no longer need yourself, after checking that.',
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
  if (total === 0 || report.rootsChangedSinceCensus) return null;
  const qualifier = report.complete ? '' : 'at least ';
  const largest = report.groups.find((group) => group.kind === 'reduce-only' && group.command && group.bytes > 0);
  const holding = `Stim: checkouts it does not fully manage hold ${qualifier}${gb(total)} of build output`;
  if (!largest?.command) return `${holding}; stim doctor lists them.`;
  return `${holding}. Adding the largest folder, ${shorten(largest.folder, home)} (${qualifier}${gb(largest.bytes)}), lets Stim apply its full rules there, finished linked worktree removal included: ${largest.command}; stim doctor lists the rest and what changes.`;
}
