import { isJsonObject, readJsonObject } from './json-file.ts';
import { discoveryScanFile } from './paths.ts';

/**
 * What the last full scan of the home folder found: the checkouts Stim's project detection recognises that
 * `maintenance.discoverRoots`, registered projects and the common tool folders do not reach, and what it could not read.
 */
export interface DiscoveryScan {
  version: 2;
  /** When the last attempt started, epoch ms. A failed or truncated attempt is stamped too. */
  ranAt: number;
  /** When the last attempt that did not fail started; 0 when none did. The weekly schedule counts from it. */
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
  /** Folders the system refused or that did not answer, skipped without error. */
  unreadable: string[];
  /** The scan stopped at its time or folder limit before it finished. */
  truncated: boolean;
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
    !strings(value.unreadable) ||
    typeof value.truncated !== 'boolean'
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
    unreadable: value.unreadable,
    truncated: value.truncated,
  };
}

export function readDiscoveryScan(): DiscoveryScan | null {
  return parseDiscoveryScan(readJsonObject(discoveryScanFile()));
}
