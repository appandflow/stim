import { buildLedgerFile } from './paths.ts';
import { parseNdjsonText, type NdjsonRecord } from './ndjson.ts';
import { readStateFile } from './json-file.ts';
import type { BuildResult } from './status.ts';

export const BUILD_LEDGER_CAP = 500;

export type BuildLedgerPlatform = 'ios' | 'android' | 'macos';

export type BuildLedgerOutcome = BuildResult;

export type BuildLedgerCacheResult = 'hit' | 'miss' | 'bypassed';

export interface BuildLedgerPlacement {
  where: 'local' | 'offloaded';
  /** The build machine that compiled the app, for an offloaded build. */
  machine?: string;
  /** The run considered offloading, then built here; `reason` says why. */
  fellBack?: true;
  reason?: string;
}

export interface BuildLedgerCache {
  result: BuildLedgerCacheResult;
  /** Where a hit came from. */
  source?: 'local' | 'remote';
  key: string | null;
  fingerprint: string | null;
  missReason?: string;
}

export interface BuildLedgerFailure {
  code: string | null;
  message: string | null;
  remedy: string | null;
  /** The phase the run was in when it failed. */
  phase: string | null;
}

/** The simulator, emulator or device the run targeted. Never a serial or UDID. */
export interface BuildLedgerDevice {
  name: string;
  runtime?: string;
}

/** One native build run, as `stim logs --source builds --json` prints it. */
export interface BuildLedgerRecord extends NdjsonRecord {
  /** Epoch milliseconds when the run finished. */
  ts: number;
  src: 'builds';
  level: 'info' | 'warn' | 'error';
  msg: string;
  event: 'build';
  id: string;
  /** Epoch milliseconds when the run started. */
  startedAt: number;
  project: string;
  workspace: string;
  branch: string | null;
  platform: BuildLedgerPlatform;
  scheme?: string;
  variant?: string;
  configuration: string | null;
  placement: BuildLedgerPlacement;
  cache: BuildLedgerCache;
  durationMs: number;
  /** Milliseconds in each local phase of the run. */
  phases: Record<string, number>;
  /** Milliseconds in each phase on the build machine (`sync`, `deps`, `prebuild`, `pods`, `build`, `fetch`). */
  offloadPhases?: Record<string, number>;
  outcome: BuildLedgerOutcome;
  failure?: BuildLedgerFailure;
  device?: BuildLedgerDevice;
  /** This machine's 5-minute load per core when the run started. Absent in older records. */
  loadPerCore?: number;
  /** The run's first owned simulator or emulator boot: when it started, in epoch milliseconds, and the load per core then. */
  boot?: BuildLedgerBoot;
  stimVersion: string;
}

export interface BuildLedgerBoot {
  startedAt: number;
  loadPerCore: number;
}

const PLATFORMS: readonly string[] = ['ios', 'android', 'macos'];
const OUTCOMES: readonly string[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function isBuildLedgerRecord(record: NdjsonRecord): record is BuildLedgerRecord {
  return (
    record.src === 'builds' &&
    record.event === 'build' &&
    typeof record.ts === 'number' &&
    typeof record.id === 'string' &&
    typeof record.platform === 'string' &&
    PLATFORMS.includes(record.platform) &&
    typeof record.outcome === 'string' &&
    OUTCOMES.includes(record.outcome) &&
    typeof record.placement === 'object' &&
    record.placement !== null &&
    typeof record.cache === 'object' &&
    record.cache !== null
  );
}

/** The ledger's records, oldest first. A missing or unreadable ledger is empty. */
export function readBuildLedger(file: string = buildLedgerFile()): BuildLedgerRecord[] {
  let text: string;
  try {
    text = readStateFile(file);
  } catch {
    return [];
  }
  return parseNdjsonText(text)
    .filter(isBuildLedgerRecord)
    .toSorted((a, b) => a.ts - b.ts);
}
