import { isAbsolute } from 'node:path';
import { isJsonObject, readJsonObject } from './json-file.ts';
import { gcMarkFile } from './paths.ts';

export const GC_MARK_VERSION = 2;

/** `outputs`: a regenerable build output or Metro store rung 1 deletes; `cargo-target`: a Cargo `target/`. */
export type GcMarkKind = 'outputs' | 'cargo-target';

export interface GcMarkCandidate {
  kind: GcMarkKind;
  path: string;
  device: number;
  /** From the disk-usage cache; null when it holds no size for the path. */
  bytes: number | null;
  measuredAt: string | null;
  /** Why the candidate is kept until its root is marked again. */
  keep?: { reason: string; at: string };
}

export type GcDependencyCandidate = Omit<GcMarkCandidate, 'kind'>;

/** Dependency inventory observed by the normal lane, independently of the output generation. */
export interface GcDependencyObservation {
  markedAt: string;
  role: 'linked' | 'source';
  keys: string[];
  candidates: GcDependencyCandidate[];
}

/** The normal worktree inventory's evidence, which grants no removal authority. */
export interface GcWorktreeObservation {
  markedAt: string;
  source: string | null;
  head: string | null;
  keys: string[];
  clean: boolean | null;
  pushed: boolean | null;
  finished: { reason: string; at: string | null } | null;
  /** The existing no-own-commits policy applies, with no open pull request. */
  emptyBranch: boolean | null;
  activity: { at: string; basis: string } | null;
  lastUsedAt: string | null;
  keep?: { code: string; reason: string; eligibleAt: string | null };
}

/** What one checkout could free, as the maintenance lane last read it. Rebuildable: a missing mark is a root due for one. */
export interface GcMark {
  v: typeof GC_MARK_VERSION;
  /** The canonical checkout root. */
  root: string;
  /** The `st_dev` of the root's volume. */
  device: number;
  markedAt: string;
  /** When a change under the root was seen; each observation is dirty while it is after its `markedAt`. */
  dirtyAt?: string;
  /** The newest activity the mark read; null when none is known. */
  lastActivityAt: string | null;
  candidates: GcMarkCandidate[];
  /** Missing or unreadable dependency evidence is unknown, not an empty inventory. */
  dependencies?: GcDependencyObservation;
  worktree?: GcWorktreeObservation;
  /** Recognized nested app paths that led normal discovery to this Cargo holder. */
  cargoVia?: string[];
}

export interface GcStaleMarkEvidence {
  root: string;
  markedAt: string;
  intervalMs: number;
}

export interface GcMarkHealth {
  at: number;
  state: 'ready' | 'partial' | 'unavailable';
  checkedRoots?: number;
  staleCount?: number;
  stale: GcStaleMarkEvidence[];
}

const KINDS: readonly unknown[] = ['outputs', 'cargo-target'] satisfies GcMarkKind[];

function isCandidate(value: unknown): value is GcMarkCandidate {
  if (!isJsonObject(value)) return false;
  const { kind, path, device, bytes, measuredAt, keep } = value;
  return (
    KINDS.includes(kind) &&
    typeof path === 'string' &&
    typeof device === 'number' &&
    (bytes === null || typeof bytes === 'number') &&
    (measuredAt === null || typeof measuredAt === 'string') &&
    (keep === undefined || (isJsonObject(keep) && typeof keep.reason === 'string' && typeof keep.at === 'string'))
  );
}

function dependencyObservation(value: unknown): GcDependencyObservation | undefined {
  if (!isJsonObject(value)) return;
  const { markedAt, role, keys, candidates } = value;
  if (
    typeof markedAt !== 'string' ||
    (role !== 'linked' && role !== 'source') ||
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === 'string' && isAbsolute(key)) ||
    !Array.isArray(candidates)
  )
    return;
  const parsed: GcDependencyCandidate[] = [];
  for (const candidate of candidates) {
    if (!isJsonObject(candidate)) return;
    const { path, device, bytes, measuredAt, keep } = candidate;
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      typeof device !== 'number' ||
      (bytes !== null && typeof bytes !== 'number') ||
      (measuredAt !== null && typeof measuredAt !== 'string')
    )
      return;
    const parsedCandidate: GcDependencyCandidate = { path, device, bytes, measuredAt };
    if (keep !== undefined) {
      if (!isJsonObject(keep) || typeof keep.reason !== 'string' || typeof keep.at !== 'string') return;
      parsedCandidate.keep = { reason: keep.reason, at: keep.at };
    }
    parsed.push(parsedCandidate);
  }
  return { markedAt, role, keys, candidates: parsed };
}

function isWorktreeObservation(value: unknown): value is GcWorktreeObservation {
  if (!isJsonObject(value)) return false;
  const { markedAt, source, head, keys, clean, pushed, finished, emptyBranch, activity, lastUsedAt, keep } = value;
  return (
    typeof markedAt === 'string' &&
    (source === null || (typeof source === 'string' && isAbsolute(source))) &&
    (head === null || typeof head === 'string') &&
    Array.isArray(keys) &&
    keys.every((key) => typeof key === 'string' && isAbsolute(key)) &&
    (clean === null || typeof clean === 'boolean') &&
    (pushed === null || typeof pushed === 'boolean') &&
    (finished === null ||
      (isJsonObject(finished) &&
        typeof finished.reason === 'string' &&
        (finished.at === null || typeof finished.at === 'string'))) &&
    (emptyBranch === null || typeof emptyBranch === 'boolean') &&
    (activity === null ||
      (isJsonObject(activity) && typeof activity.at === 'string' && typeof activity.basis === 'string')) &&
    (lastUsedAt === null || typeof lastUsedAt === 'string') &&
    (keep === undefined ||
      (isJsonObject(keep) &&
        typeof keep.code === 'string' &&
        typeof keep.reason === 'string' &&
        (keep.eligibleAt === null || typeof keep.eligibleAt === 'string')))
  );
}

/** Validates one saved mark against its canonical root without reading the filesystem. */
export function parseGcMark(root: string, entry: unknown): GcMark | null {
  if (!isJsonObject(entry) || entry.v !== GC_MARK_VERSION || entry.root !== root) return null;
  const { device, markedAt, dirtyAt, lastActivityAt, candidates } = entry;
  if (
    typeof device !== 'number' ||
    typeof markedAt !== 'string' ||
    (dirtyAt !== undefined && typeof dirtyAt !== 'string') ||
    (lastActivityAt !== null && typeof lastActivityAt !== 'string') ||
    !Array.isArray(candidates)
  )
    return null;
  const parsed = candidates.filter(isCandidate);
  if (parsed.length !== candidates.length) return null;
  const dependencies = dependencyObservation(entry.dependencies);
  return {
    v: GC_MARK_VERSION,
    root,
    device,
    markedAt,
    ...(dirtyAt === undefined ? {} : { dirtyAt }),
    lastActivityAt,
    candidates: parsed,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(isWorktreeObservation(entry.worktree) ? { worktree: entry.worktree } : {}),
    ...(Array.isArray(entry.cargoVia) && entry.cargoVia.every((path) => typeof path === 'string' && isAbsolute(path))
      ? { cargoVia: entry.cargoVia }
      : {}),
  };
}

/** The mark of the checkout at the canonical path `root`; null when there is none, or it has another version or does not parse. */
export function readGcMark(root: string): GcMark | null {
  return parseGcMark(root, readJsonObject(gcMarkFile(root)));
}
