import { isJsonObject, readJsonObject } from './json-file.ts';
import { workspaceFingerprintMemoFile } from './paths.ts';

export const FINGERPRINT_MEMO_SCHEMA = 1;

/** One input of a recorded fingerprint: its absolute path, `f`, `d` or `-` (absent), and its stat stamp. */
export type FingerprintMemoRow = [path: string, kind: 'f' | 'd' | '-', stamp: string];

export interface FingerprintMemoRecord {
  schema: typeof FINGERPRINT_MEMO_SCHEMA;
  identity: string;
  recordedAt: number;
  hash: string;
  sources: unknown[];
  configDigest: string;
  rows: FingerprintMemoRow[];
}

function isRow(value: unknown): value is FingerprintMemoRow {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    (value[1] === 'f' || value[1] === 'd' || value[1] === '-') &&
    typeof value[2] === 'string'
  );
}

export function readFingerprintMemo(projectRoot: string, platform: string): FingerprintMemoRecord | null {
  const record = readJsonObject(workspaceFingerprintMemoFile(projectRoot, platform));
  if (
    !record ||
    record.schema !== FINGERPRINT_MEMO_SCHEMA ||
    typeof record.identity !== 'string' ||
    typeof record.recordedAt !== 'number' ||
    typeof record.hash !== 'string' ||
    !Array.isArray(record.sources) ||
    !record.sources.every(isJsonObject) ||
    typeof record.configDigest !== 'string' ||
    !Array.isArray(record.rows) ||
    !record.rows.every(isRow)
  )
    return null;
  return {
    schema: FINGERPRINT_MEMO_SCHEMA,
    identity: record.identity,
    recordedAt: record.recordedAt,
    hash: record.hash,
    sources: record.sources,
    configDigest: record.configDigest,
    rows: record.rows,
  };
}
