import { isJsonObject, readStateFile } from './json-file.ts';
import { discoveryCensusFile } from './paths.ts';

/**
 * A checkout the last full scan found that Stim does not fully manage: `reduce-only` ones are reduced and never removed,
 * `dot-folder` ones lie under a home dot-folder, where Stim does nothing with them, and `unchecked` ones could not be
 * revalidated this time because a read did not answer (neither managed nor gone; any measurement is from an earlier run).
 */
export interface CensusFind {
  path: string;
  kind: 'reduce-only' | 'dot-folder' | 'unchecked';
  /** The folder whose direct children include the checkout, the one `maintenance.discoverRoots` would take. */
  folder: string;
  /** Whether `maintenance.discoverRoots` can name `folder`: the home folder and the folders holding it cannot. */
  adoptable: boolean;
  /** When its build output was last measured, epoch ms; 0 when it was not measured yet. */
  evaluatedAt: number;
  /** The recognised build directories in it, the ones Stim would clear. */
  dirs: number;
  /** How many of them were measured, and how many were tried and failed or timed out (the rest are not measured yet). */
  measuredDirs: number;
  failedDirs: number;
  /** The bytes of the measured directories; never an estimate of the others. */
  bytes: number;
  /** Listing its build directories failed or did not answer, so nothing about its output is known. */
  unreadable: boolean;
  /**
   * When git last wrote in the checkout (epoch ms): the newest modification time of the git directory's HEAD, index and
   * logs/HEAD. Null is unknown, never old. It says nothing about edits made without touching git.
   */
  gitActivityAt: number | null;
}

/**
 * What the daemon derived from the last full scan for the doctor listing and the low-disk line: which finds Stim does
 * not fully manage, and the size of their build output. Commands read it and never walk the disk.
 */
export interface DiscoveryCensus {
  version: 1;
  /** When the daemon last wrote it, epoch ms. */
  at: number;
  /** The `ranAt` of the scan it was derived from. */
  scanRanAt: number;
  /** The `maintenance.discoverRoots` entries it was classified under, as absolute paths. */
  roots: string[];
  /** The existing, non-broad folders of `roots` with symlinks resolved, as the classification used; commands compare strings only. */
  canonicalRoots: string[];
  /** Some find has a directory not measured yet, so another run continues. */
  pending: boolean;
  finds: CensusFind[];
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function parseFind(value: unknown): CensusFind | null {
  if (
    !isJsonObject(value) ||
    typeof value.path !== 'string' ||
    (value.kind !== 'reduce-only' && value.kind !== 'dot-folder' && value.kind !== 'unchecked') ||
    typeof value.folder !== 'string' ||
    typeof value.adoptable !== 'boolean' ||
    !finite(value.evaluatedAt) ||
    !finite(value.dirs) ||
    !finite(value.measuredDirs) ||
    !finite(value.failedDirs) ||
    !finite(value.bytes) ||
    typeof value.unreadable !== 'boolean' ||
    (value.gitActivityAt !== null && !finite(value.gitActivityAt))
  )
    return null;
  return {
    path: value.path,
    kind: value.kind,
    folder: value.folder,
    adoptable: value.adoptable,
    evaluatedAt: value.evaluatedAt,
    dirs: value.dirs,
    measuredDirs: value.measuredDirs,
    failedDirs: value.failedDirs,
    bytes: value.bytes,
    unreadable: value.unreadable,
    gitActivityAt: value.gitActivityAt,
  };
}

/** Rejects missing, corrupt or unsupported payloads without throwing. */
export function parseDiscoveryCensus(value: unknown): DiscoveryCensus | null {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !finite(value.at) ||
    !finite(value.scanRanAt) ||
    !strings(value.roots) ||
    !strings(value.canonicalRoots) ||
    typeof value.pending !== 'boolean' ||
    !Array.isArray(value.finds)
  )
    return null;
  const finds: CensusFind[] = [];
  for (const entry of value.finds) {
    const find = parseFind(entry);
    if (!find) return null;
    finds.push(find);
  }
  return {
    version: 1,
    at: value.at,
    scanRanAt: value.scanRanAt,
    roots: value.roots,
    canonicalRoots: value.canonicalRoots,
    pending: value.pending,
    finds,
  };
}

/**
 * The census file: `absent` (the daemon has not written one), `unreadable` (it exists and could not be read), or `read`
 * with the census, which is null when the contents do not parse or are another version.
 */
export type DiscoveryCensusFile =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'read'; census: DiscoveryCensus | null };

export function readDiscoveryCensusFile(): DiscoveryCensusFile {
  let text: string;
  try {
    text = readStateFile(discoveryCensusFile());
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unreadable' };
  }
  try {
    return { status: 'read', census: parseDiscoveryCensus(JSON.parse(text)) };
  } catch {
    return { status: 'read', census: null };
  }
}
