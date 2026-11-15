import { isJsonObject, readJsonObject } from './json-file.ts';
import { discoveryScanFile } from './paths.ts';

/** How an attempt ended: finished, cut short by the folder cap or the time budget, or by a read that timed out or a failure. */
export type ScanTruncation = 'none' | 'budget' | 'folders' | 'read' | 'failed';

const isTruncation = (value: unknown): value is ScanTruncation =>
  value === 'none' || value === 'budget' || value === 'folders' || value === 'read' || value === 'failed';

/**
 * What the last full scan of the home folder found: the checkouts Stim's project detection recognises that
 * `maintenance.discoverRoots`, registered projects and the common tool folders do not reach, and what it could not read.
 */
export interface DiscoveryScan {
  version: 2;
  /** When the last attempt started, epoch ms. A failed or truncated attempt is stamped too. */
  ranAt: number;
  /** When the last attempt that finished, neither failed nor truncated, started; 0 when none did. The weekly schedule counts from it. */
  completedAt: number;
  /** When the last attempt that ran while a volume's level was above normal started; 0 when none did. */
  lowScanAt: number;
  durationMs: number;
  trigger: 'weekly' | 'low-disk';
  /** Folders the scan read. */
  visited: number;
  /**
   * Canonical paths of the recognised checkouts. A failed or truncated scan keeps the previous scan's finds that it did
   * not reach, and a scan keeps those under a folder it could not read; discovery revalidates each before using it.
   */
  found: string[];
  /**
   * Canonical paths of recognised checkouts under a dot-folder of the home folder, recorded for the doctor listing and
   * never used by discovery: Stim cannot tell an installed tool from a checkout there.
   */
  dotFolderFound: string[];
  /** Folders the system refused or that did not answer, skipped without error. */
  unreadable: string[];
  /** The scan stopped at its time or folder limit, or on a read or failure, before it finished. */
  truncated: boolean;
  /** How the attempt ended. `read` and `failed` are retried after an hour; the others follow the weekly schedule. */
  truncation: ScanTruncation;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Rejects missing, corrupt or unsupported payloads without throwing. */
export function parseDiscoveryScan(value: unknown): DiscoveryScan | null {
  if (
    !isJsonObject(value) ||
    value.version !== 2 ||
    !finite(value.ranAt) ||
    !finite(value.completedAt) ||
    !finite(value.lowScanAt) ||
    !finite(value.durationMs) ||
    (value.trigger !== 'weekly' && value.trigger !== 'low-disk') ||
    !finite(value.visited) ||
    !strings(value.found) ||
    !strings(value.dotFolderFound) ||
    !strings(value.unreadable) ||
    typeof value.truncated !== 'boolean' ||
    !isTruncation(value.truncation)
  )
    return null;
  return {
    version: 2,
    ranAt: value.ranAt,
    completedAt: value.completedAt,
    lowScanAt: value.lowScanAt,
    durationMs: value.durationMs,
    trigger: value.trigger,
    visited: value.visited,
    found: value.found,
    dotFolderFound: value.dotFolderFound,
    unreadable: value.unreadable,
    truncated: value.truncated,
    truncation: value.truncation,
  };
}

export function readDiscoveryScan(): DiscoveryScan | null {
  return parseDiscoveryScan(readJsonObject(discoveryScanFile()));
}
