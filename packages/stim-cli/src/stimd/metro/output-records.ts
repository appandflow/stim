import type { NdjsonRecord } from '../../ndjson.ts';
import { recordFromLine } from './server-expo.ts';
import { repackRecords } from './server-repack.ts';
import { MODE_COMMAND, MODE_EXPO, MODE_REPACK } from './state.ts';

/** How a dev server's output lines become `metro.ndjson` records: as the dev server of its mode writes them. */
export function outputRecord(mode: string): (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null {
  if (mode === MODE_COMMAND) return (chunk, stream) => recordFromLine(chunk, { stream, source: 'command' });
  if (mode === MODE_EXPO) return (chunk, stream) => recordFromLine(chunk, { stream });
  if (mode === MODE_REPACK) return repackRecords();
  return (chunk, stream) => {
    const entry = recordFromLine(chunk, { stream });
    return entry?.raw ? { ...entry, event: `host_${stream}` } : entry;
  };
}
