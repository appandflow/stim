import { isJsonObject, readJsonObject } from './json-file.ts';
import { discoveryScanFile } from './paths.ts';

/**
 * What the last full scan of the home folder found: the checkouts Stim's project detection recognises that
 * `maintenance.discoverRoots`, registered projects and the common tool folders do not reach, and what it could not read.
 */
export interface DiscoveryScan {
  version: 1;
  /** When the scan started, epoch ms. A scan that failed or ran out of time is stamped too. */
  ranAt: number;
  durationMs: number;
  trigger: 'weekly' | 'low-disk';
  /** Folders the scan read. */
  visited: number;
  /** Canonical paths of the recognised checkouts. */
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
    value.version !== 1 ||
    !finite(value.ranAt) ||
    !finite(value.durationMs) ||
    (value.trigger !== 'weekly' && value.trigger !== 'low-disk') ||
    !finite(value.visited) ||
    !strings(value.found) ||
    !strings(value.unreadable) ||
    typeof value.truncated !== 'boolean'
  )
    return null;
  return {
    version: 1,
    ranAt: value.ranAt,
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
