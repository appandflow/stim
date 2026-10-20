import { open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { rotatedLogPath } from '../index.ts';
import {
  attachExpoErrorContext,
  isExpoErrorContext,
  bundleMarkerPlatform,
  fileIdentity,
  NATIVE_CRASH_LOG_PREFIX,
  planLogQuery,
} from './logs-query.ts';
import type { LogQueryOptions, LogQueryPlan } from './logs-query.ts';
import { levelRank, parseNdjsonLine, type NdjsonRecord } from './ndjson.ts';
import { BoundedSelection } from './log-selection.ts';

const BLOCK_BYTES = 64 * 1024;
const MAX_CACHED_GENERATIONS = 512;
const NEWLINE = 0x0a;
const VALIDATE_BYTES = 256;

interface Block {
  start: number;
  end: number;
  maxTs: number;
  minTs: number;
  sources: Set<string | undefined>;
  levels: Set<string | undefined>;
}

interface Positioned {
  record: NdjsonRecord;
  position: number;
}

interface GenerationIndex {
  size: number;
  head: Buffer;
  tail: Buffer;
  blocks: Block[];
  minTs: number | null;
  markers: Map<string, NdjsonRecord>;
  launchAttempts: Positioned[];
  slots: Set<unknown>;
}

interface Generation {
  handle: FileHandle;
  rank: number;
  generation: number;
  crash: boolean;
  index: GenerationIndex;
}

interface Entry {
  ts: number;
  rank: number;
  generation: number;
  position: number;
  record: NdjsonRecord;
}

const cache = new Map<string, GenerationIndex>();
const indexing = new Map<string, Promise<GenerationIndex>>();

function tsKey(record: NdjsonRecord): number {
  return typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : Infinity;
}

function compare(a: Omit<Entry, 'record'>, b: Omit<Entry, 'record'>): number {
  return a.ts - b.ts || a.rank - b.rank || a.generation - b.generation || a.position - b.position;
}

function markerTs(record: NdjsonRecord): number {
  const ts = tsKey(record);
  return ts === Infinity ? -Infinity : ts;
}

function keepNewer(markers: Map<string, NdjsonRecord>, key: string, marker: NdjsonRecord): void {
  const known = markers.get(key);
  if (!known || markerTs(marker) > markerTs(known)) markers.set(key, marker);
}

function markerKey(record: NdjsonRecord): { key: string; marker: NdjsonRecord } {
  const platform =
    record.src === 'metro'
      ? bundleMarkerPlatform(record)
      : typeof record.platform === 'string'
        ? record.platform
        : null;
  const ts = tsKey(record);
  return {
    key: JSON.stringify([record.src ?? null, record.slot === undefined ? 0 : [record.slot], platform]),
    marker: {
      src: record.src,
      marker: true,
      ...(ts === Infinity ? {} : { ts }),
      ...(record.slot === undefined ? {} : { slot: record.slot }),
      ...(platform === null ? {} : { platform }),
    },
  };
}

function emptyIndex(): GenerationIndex {
  return {
    size: 0,
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    blocks: [],
    minTs: null,
    markers: new Map(),
    launchAttempts: [],
    slots: new Set(),
  };
}

function indexBlock(index: GenerationIndex, buffer: Buffer, start: number): Block {
  let maxTs = -Infinity;
  let minTs = Infinity;
  const sources = new Set<string | undefined>();
  const levels = new Set<string | undefined>();
  for (let lineStart = 0; lineStart < buffer.length;) {
    const lineEnd = buffer.indexOf(NEWLINE, lineStart);
    const record = parseNdjsonLine(buffer.toString('utf8', lineStart, lineEnd));
    if (record) {
      const value = tsKey(record);
      maxTs = Math.max(maxTs, value);
      minTs = Math.min(minTs, value);
      if (value !== Infinity && (index.minTs === null || value < index.minTs)) index.minTs = value;
      sources.add(record.src);
      levels.add(record.level);
      index.slots.add(record.slot ?? 'default');
      if (record.marker === true) {
        const { key, marker } = markerKey(record);
        keepNewer(index.markers, key, marker);
      }
      if (record.event === 'launch_attempt') index.launchAttempts.push({ record, position: start + lineStart });
    }
    lineStart = lineEnd + 1;
  }
  return { start, end: start + buffer.length, maxTs, minTs, sources, levels };
}

async function read(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

async function stillExtends(handle: FileHandle, index: GenerationIndex, size: number): Promise<boolean> {
  if (size < index.size) return false;
  const head = await read(handle, 0, index.head.length);
  const tail = await read(handle, index.size - index.tail.length, index.tail.length);
  return head.equals(index.head) && tail.equals(index.tail);
}

function resumeFrom(index: GenerationIndex): GenerationIndex {
  const last = index.blocks.at(-1);
  if (!last || last.end - last.start >= BLOCK_BYTES) return { ...index, blocks: [...index.blocks] };
  return {
    ...index,
    size: last.start,
    blocks: index.blocks.slice(0, -1),
    launchAttempts: index.launchAttempts.filter((attempt) => attempt.position < last.start),
  };
}

async function indexGeneration(
  handle: FileHandle,
  identity: string,
  size: number,
  signal?: AbortSignal,
): Promise<GenerationIndex> {
  signal?.throwIfAborted();
  const pending = indexing.get(identity);
  if (pending) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      void pending
        .then(
          () => resolve(),
          () => resolve(),
        )
        .finally(() => signal?.removeEventListener('abort', cancel));
    });
    return indexGeneration(handle, identity, size, signal);
  }
  const building = buildGenerationIndex(handle, identity, size, signal);
  indexing.set(identity, building);
  try {
    return await building;
  } finally {
    indexing.delete(identity);
  }
}

async function buildGenerationIndex(handle: FileHandle, identity: string, size: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cached = cache.get(identity);
  const known = cached && (await stillExtends(handle, cached, size)) ? cached : null;
  if (known && known.size === size) {
    cache.delete(identity);
    cache.set(identity, known);
    return known;
  }
  const index = known ? resumeFrom(known) : emptyIndex();
  const next: GenerationIndex = {
    ...index,
    markers: new Map(index.markers),
    launchAttempts: [...index.launchAttempts],
    slots: new Set(index.slots),
  };
  let offset = next.size;
  let length = BLOCK_BYTES;
  while (offset < size) {
    signal?.throwIfAborted();
    const buffer = await read(handle, offset, Math.min(length, size - offset));
    const end = buffer.lastIndexOf(NEWLINE);
    if (end === -1) {
      if (buffer.length < Math.min(length, size - offset) || offset + buffer.length >= size) break;
      length *= 2;
      continue;
    }
    next.blocks.push(indexBlock(next, buffer.subarray(0, end + 1), offset));
    offset += end + 1;
    length = BLOCK_BYTES;
    signal?.throwIfAborted();
    await nextTurn();
  }
  next.size = offset;
  next.head = await read(handle, 0, Math.min(VALIDATE_BYTES, offset));
  next.tail = await read(handle, Math.max(0, offset - VALIDATE_BYTES), Math.min(VALIDATE_BYTES, offset));
  cache.delete(identity);
  cache.set(identity, next);
  while (cache.size > MAX_CACHED_GENERATIONS) cache.delete(cache.keys().next().value!);
  return next;
}

export interface LogDirQuery extends LogQueryOptions {
  tail?: number;
  /** Records from outside the directory, such as agent-device actions; they follow its records at equal timestamps. */
  extra?: readonly NdjsonRecord[];
}

/**
 * An indexed view of a workspace log directory, read in timestamp order without loading whole files. Each file
 * generation is indexed once per process (block timestamp bounds, markers, slots and launch attempts) and later
 * views read only what was appended since. Close it to release the open files.
 */
export interface LogDir {
  /** Bytes read from each current `.ndjson` file, through its last complete line. */
  readonly sizes: Record<string, number>;
  /** `fileIdentity` of each current `.ndjson` file that `sizes` was read from. */
  readonly identities: Record<string, string>;
  /** The oldest timestamp in the directory. */
  readonly firstTs: number | undefined;
  /** Launch attempt records outside native crash files, in timeline order. */
  launchAttempts(): NdjsonRecord[];
  /** The records `queryJsonLogs` returns for this directory's timeline followed by `extra`. */
  query(query?: LogDirQuery): Promise<NdjsonRecord[]>;
  /** Every matching record in timestamp order, in batches of at most 500, with the same filters and context as query. */
  batches(query?: Omit<LogDirQuery, 'tail'>): AsyncIterable<NdjsonRecord[]>;
  /** Prepares the directory marker predicate for records without markers, such as attributed agent actions. */
  filter(query?: LogQueryOptions): (record: NdjsonRecord) => boolean;
  close(): Promise<void>;
}

/**
 * Opens `dir` for reading. With `order: 'timeline'`, native crash files follow every other file at equal
 * timestamps, as `readLogTimeline` orders them; with `'name'`, every file is ranked by name, as `readLogRecords`.
 */
export async function openLogDir(
  dir: string,
  { order = 'timeline', signal }: { order?: 'timeline' | 'name'; signal?: AbortSignal } = {},
): Promise<LogDir> {
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    names = [];
  }
  const ranked =
    order === 'name'
      ? names
      : [
          ...names.filter((name) => !name.startsWith(NATIVE_CRASH_LOG_PREFIX)),
          ...names.filter((name) => name.startsWith(NATIVE_CRASH_LOG_PREFIX)),
        ];
  const generations: Generation[] = [];
  const sizes: Record<string, number> = {};
  const identities: Record<string, string> = {};
  const close = async () => {
    await Promise.all(generations.map((generation) => generation.handle.close().catch(() => {})));
  };
  try {
    for (const [rank, name] of ranked.entries()) {
      for (const [generation, path] of [rotatedLogPath(join(dir, name)), join(dir, name)].entries()) {
        let handle: FileHandle;
        try {
          handle = await open(path, 'r');
        } catch {
          continue;
        }
        try {
          const stat = await handle.stat({ bigint: true });
          const index = await indexGeneration(handle, `${stat.dev}:${stat.ino}`, Number(stat.size), signal);
          generations.push({ handle, rank, generation, crash: name.startsWith(NATIVE_CRASH_LOG_PREFIX), index });
          if (generation === 1) {
            sizes[name] = index.size;
            const identity = fileIdentity(stat);
            if (identity !== undefined) identities[name] = identity;
          }
        } catch (error) {
          await handle.close().catch(() => {});
          throw error;
        }
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  let firstTs: number | undefined;
  for (const { index } of generations) {
    if (index.minTs !== null && (firstTs === undefined || index.minTs < firstTs)) firstTs = index.minTs;
  }
  return {
    sizes,
    identities,
    firstTs,
    launchAttempts: () =>
      generations
        .filter((generation) => !generation.crash)
        .flatMap(({ index, rank, generation }) =>
          index.launchAttempts.map(({ record, position }) => ({
            ts: tsKey(record),
            rank,
            generation,
            position,
            record,
          })),
        )
        .toSorted(compare)
        .map((entry) => entry.record),
    query: (query = {}) => queryGenerations(generations, query, signal),
    batches: (query = {}) => queryBatches(generations, query, signal),
    filter: (query = {}) => planLogQuery(generationMarkers(generations), query).matches,
    close,
  };
}

function blockMatches(block: Block, { errorsOnly, minLevel, sources }: LogQueryOptions): boolean {
  if (errorsOnly && !block.levels.has('error') && !block.levels.has('fatal')) return false;
  if (minLevel && ![...block.levels].some((level) => levelRank(level) >= levelRank(minLevel))) return false;
  return (
    !sources?.length ||
    sources.some((source) => block.sources.has(source)) ||
    Boolean(errorsOnly && block.sources.has('device'))
  );
}

async function select(
  generations: Generation[],
  extra: readonly NdjsonRecord[],
  {
    matches,
    excludesUpTo,
    mayContain,
    tail,
    first = false,
  }: {
    matches: (record: NdjsonRecord, entry: Entry) => boolean;
    excludesUpTo: (maxTs: number) => boolean;
    mayContain: (block: Block, generation: Generation) => boolean;
    tail: number | undefined;
    first?: boolean;
  },
  signal: AbortSignal | undefined,
): Promise<Entry[]> {
  if (tail !== undefined && tail <= 0) return [];
  const heap = new BoundedSelection<Entry>(compare, tail, first);
  const extraRank = generations.length ? Math.max(...generations.map((generation) => generation.rank)) + 1 : 0;
  for (const [position, record] of extra.entries()) {
    const entry = { ts: tsKey(record), rank: extraRank, generation: 0, position, record };
    if (matches(record, entry)) heap.keep(entry);
  }
  const blocks = generations
    .flatMap((generation) => generation.index.blocks.map((block) => ({ generation, block })))
    .toSorted((a, b) => (first ? a.block.minTs - b.block.minTs : b.block.maxTs - a.block.maxTs) || 0);
  for (const { generation, block } of blocks) {
    if (excludesUpTo(block.maxTs)) {
      if (first) continue;
      break;
    }
    if (first && tail !== undefined && heap.size >= tail && block.minTs > heap.peek()!.ts) break;
    if (!first && tail !== undefined && heap.size >= tail && block.maxTs < heap.peek()!.ts) break;
    signal?.throwIfAborted();
    if (!mayContain(block, generation)) continue;
    const buffer = await read(generation.handle, block.start, block.end - block.start);
    for (let lineStart = 0; lineStart < buffer.length;) {
      const lineEnd = buffer.indexOf(NEWLINE, lineStart);
      if (lineEnd === -1) break;
      const record = parseNdjsonLine(buffer.toString('utf8', lineStart, lineEnd));
      const position = block.start + lineStart;
      lineStart = lineEnd + 1;
      if (!record) continue;
      const entry = {
        ts: tsKey(record),
        rank: generation.rank,
        generation: generation.generation,
        position,
        record,
      };
      if (matches(record, entry)) heap.keep(entry);
    }
    await nextTurn();
  }
  return heap.sorted();
}

function generationMarkers(generations: Generation[]): NdjsonRecord[] {
  const markers = new Map<string, NdjsonRecord>();
  for (const { index } of generations) for (const [key, marker] of index.markers) keepNewer(markers, key, marker);
  return [...markers.values()];
}

async function selectQuery(
  generations: Generation[],
  { tail, extra = [], ...options }: LogDirQuery,
  signal: AbortSignal | undefined,
  page?: { after: Entry | undefined; size: number },
): Promise<Entry[]> {
  signal?.throwIfAborted();
  const slots = new Set<unknown>(['default']);
  for (const { index } of generations) {
    for (const slot of index.slots) slots.add(slot);
  }
  for (const record of extra) slots.add(record.slot ?? 'default');
  const plan: LogQueryPlan = planLogQuery(
    [...generationMarkers(generations), ...extra.filter((record) => record.marker === true)],
    options,
  );
  return select(
    generations,
    extra,
    {
      matches: (record, entry) => plan.matches(record) && (!page?.after || compare(entry, page.after) > 0),
      excludesUpTo: (maxTs) => plan.excludesUpTo(maxTs, slots),
      mayContain: (block, generation) =>
        blockMatches(block, options) &&
        (!page?.after ||
          compare(
            { ts: block.maxTs, rank: generation.rank, generation: generation.generation, position: block.end },
            page.after,
          ) > 0),
      tail: page?.size ?? tail,
      first: page !== undefined,
    },
    signal,
  );
}

async function queryGenerations(
  generations: Generation[],
  query: LogDirQuery,
  signal: AbortSignal | undefined,
): Promise<NdjsonRecord[]> {
  return withErrorContext(generations, query, await selectQuery(generations, query, signal), signal);
}

async function* queryBatches(
  generations: Generation[],
  query: Omit<LogDirQuery, 'tail'>,
  signal: AbortSignal | undefined,
): AsyncIterable<NdjsonRecord[]> {
  const fixed = { ...query, now: query.now ?? Date.now() };
  let after: Entry | undefined;
  for (;;) {
    const selected = await selectQuery(generations, fixed, signal, { after, size: 500 });
    if (!selected.length) return;
    yield await withErrorContext(generations, fixed, selected, signal);
    after = selected.at(-1);
  }
}

async function withErrorContext(
  generations: Generation[],
  { extra = [], ...options }: LogDirQuery,
  selected: Entry[],
  signal: AbortSignal | undefined,
): Promise<NdjsonRecord[]> {
  const matched = selected.map((entry) => entry.record);
  if (!options.errorsOnly) return matched;
  const errors = matched.filter(
    (record) =>
      record.src === 'metro' &&
      record.raw === true &&
      (record.level === 'error' || record.level === 'fatal') &&
      typeof record.msg === 'string',
  );
  if (!errors.length) return matched;
  const contextual = new Map<NdjsonRecord, NdjsonRecord>();
  for (const error of errors) {
    const [first] = await select(
      generations,
      extra,
      {
        matches: (record) =>
          record.ts === error.ts &&
          record.src === error.src &&
          record.msg === error.msg &&
          record.event === error.event,
        excludesUpTo: (maxTs) => maxTs < tsKey(error),
        mayContain: (block) => block.sources.has('metro'),
        tail: 1,
        first: true,
      },
      signal,
    );
    if (!first) continue;
    let limit = 32;
    for (;;) {
      const streamEntries = await select(
        generations,
        extra,
        {
          matches: (record, entry) =>
            compare(entry, first) >= 0 &&
            record.src === 'metro' &&
            record.event === error.event &&
            tsKey(record) >= tsKey(error) &&
            (record.raw === true || (record.ts === error.ts && record.msg === error.msg)),
          excludesUpTo: (maxTs) => maxTs < tsKey(error),
          mayContain: (block) => block.sources.has('metro'),
          tail: limit,
          first: true,
        },
        signal,
      );
      const stream = streamEntries.map((entry) => entry.record);
      const index = stream.findIndex((record) => record.ts === error.ts && record.msg === error.msg);
      const finished =
        index < 0 ||
        stream.slice(index + 1).some((record) => record.raw === true && !isExpoErrorContext(record, error.event));
      if (finished || stream.length < limit) {
        contextual.set(error, attachExpoErrorContext(stream, [error], 'field')[0]!);
        break;
      }
      limit *= 2;
    }
  }
  return matched.map((record) => contextual.get(record) ?? record);
}
