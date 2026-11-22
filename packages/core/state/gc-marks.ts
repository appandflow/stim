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

/** What one checkout could free, as the maintenance lane last read it. Rebuildable: a missing mark is a root due for one. */
export interface GcMark {
  v: typeof GC_MARK_VERSION;
  /** The canonical checkout root. */
  root: string;
  /** The `st_dev` of the root's volume. */
  device: number;
  markedAt: string;
  /** When a change under the root was seen; the root is dirty while it is after `markedAt`. */
  dirtyAt?: string;
  /** The newest activity the mark read; null when none is known. */
  lastActivityAt: string | null;
  candidates: GcMarkCandidate[];
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

/** The mark of the checkout at the canonical path `root`; null when there is none, or it has another version or does not parse. */
export function readGcMark(root: string): GcMark | null {
  const entry = readJsonObject(gcMarkFile(root));
  if (!entry || entry.v !== GC_MARK_VERSION || entry.root !== root) return null;
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
  return {
    v: GC_MARK_VERSION,
    root,
    device,
    markedAt,
    ...(dirtyAt === undefined ? {} : { dirtyAt }),
    lastActivityAt,
    candidates: parsed,
  };
}
