import { closeSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { rotatedLogPath } from '../index.ts';
import { type NdjsonRecord, levelRank, parseNdjsonLine, readNdjsonGenerations } from './ndjson.ts';

const SINCE_UNITS: { s: number; m: number; h: number } = { s: 1000, m: 60000, h: 3600000 };
const SINCE_FORMS = '30s, 5m, 2h';

interface SinceResult {
  ms?: number;
  error?: string;
}

interface GrepResult {
  re?: RegExp;
  error?: string;
}

interface MarkerWindow {
  launchTs: number | null;
  bundleTs: number | null;
  pageLoadTs: number | null;
}

export interface QueryCriteria {
  slot?: string;
  includeAppDeviceErrors?: boolean;
  sources?: string[];
  minLevel?: string;
  grep?: RegExp;
  sinceTs?: number;
  errorsOnly?: boolean;
  markerTs?: number;
  bundleMarkerTs?: number;
}

interface TailState {
  offset: number;
  partial: string;
}

export function parseSince(text: unknown): SinceResult {
  if (typeof text !== 'string') {
    return { error: `Invalid --since value ${JSON.stringify(text)}. Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  const m = /^(\d+)\s*([smh])$/i.exec(text.trim());
  if (!m) {
    return { error: `Invalid --since value "${text}". Use a count and a unit, e.g. ${SINCE_FORMS}.` };
  }
  const unit = (m[2] ?? '').toLowerCase() as keyof typeof SINCE_UNITS;
  return { ms: parseInt(m[1] ?? '', 10) * SINCE_UNITS[unit] };
}

export function compileGrep(pattern: unknown): GrepResult {
  if (pattern instanceof RegExp) return { re: pattern };
  try {
    return { re: new RegExp(String(pattern)) };
  } catch (err) {
    return { error: `Invalid --grep pattern "${pattern}": ${(err as Error).message}` };
  }
}

export const ERROR_SOURCES: string[] = ['metro', 'client', 'build'];

export function markerWindow(records: NdjsonRecord[]): MarkerWindow {
  let launchTs: number | null = null;
  let bundleTs: number | null = null;
  let pageLoadTs: number | null = null;
  for (const r of records) {
    if (r?.marker !== true) continue;
    const ts = tsOf(r);
    if (ts === null) continue;
    if (r.src === 'metro') {
      if (bundleTs === null || ts > bundleTs) bundleTs = ts;
    } else if (isWebPageRecord(r)) {
      if (pageLoadTs === null || ts > pageLoadTs) pageLoadTs = ts;
    } else if (launchTs === null || ts > launchTs) {
      launchTs = ts;
    }
  }
  return { launchTs, bundleTs, pageLoadTs };
}

function isWebPageRecord(record: NdjsonRecord): boolean {
  return record.platform === 'web' && record.src !== 'metro';
}

function isSharedRecord(record: NdjsonRecord): boolean {
  return record.slot === undefined && (record.src === 'metro' || record.src === 'client') && !isWebPageRecord(record);
}

function inSlot(record: NdjsonRecord, slot: string): boolean {
  return isSharedRecord(record) || (record.slot ?? 'default') === slot;
}

/**
 * The platform a bundle marker speaks for, lowercased: its `platform` field, or the tag @expo/cli prints before
 * "Bundled" ("iOS", "Android", "Web", "RSC(iOS)" as ios, or an environment tag such as "DOM"). Null when unknown.
 */
export function bundleMarkerPlatform(record: NdjsonRecord): string | null {
  if (typeof record.platform === 'string') return record.platform;
  const tag = /^\s*(\S+)\s+Bundl/.exec(String(record.msg ?? ''))?.[1];
  if (!tag) return null;
  return (/^RSC\((.+)\)$/.exec(tag)?.[1] ?? tag).toLowerCase();
}

function isAppDeviceRecord(record: NdjsonRecord): boolean {
  return (
    record.src === 'device' &&
    (record.event === 'native_crash' || record.event === 'hosted_native_log' || record.platform === 'web')
  );
}

export function recordMatches(record: NdjsonRecord | null | undefined, criteria: QueryCriteria = {}): boolean {
  if (!record) return false;
  if (criteria.slot !== undefined && !inSlot(record, criteria.slot)) return false;
  const { sources, minLevel, grep, sinceTs, errorsOnly, markerTs, bundleMarkerTs } = criteria;

  if (
    sources &&
    sources.length > 0 &&
    !sources.includes(record.src as string) &&
    !(criteria.includeAppDeviceErrors && isAppDeviceRecord(record))
  )
    return false;
  if (minLevel && levelRank(record.level) < levelRank(minLevel)) return false;

  if (errorsOnly) {
    if (record.src === 'maintenance' && record.event !== 'maintenance_failure') return false;
    if (record.level !== 'error' && record.level !== 'fatal') return false;
    if (typeof markerTs === 'number') {
      const ts = tsOf(record);
      if (ts === null || ts <= markerTs) return false;
    }
    if (typeof bundleMarkerTs === 'number' && record.src === 'metro') {
      const ts = tsOf(record);
      if (ts === null || ts < bundleMarkerTs) return false;
    }
  }

  if (typeof sinceTs === 'number') {
    const ts = tsOf(record);
    if (ts === null || ts < sinceTs) return false;
  }

  if (grep) {
    const re = grep instanceof RegExp ? grep : compileGrep(grep).re;
    if (!re || String(record.msg ?? '').search(re) === -1) return false;
  }

  return true;
}

export function buildCriteria({
  slot,
  sources,
  minLevel,
  since,
  grep,
  errorsOnly,
  markerTs,
  bundleMarkerTs,
  now,
}: {
  slot?: string;
  sources?: string[];
  minLevel?: string;
  since?: string | null;
  grep?: string | RegExp | null;
  errorsOnly?: boolean;
  markerTs?: number;
  bundleMarkerTs?: number;
  now?: number;
} = {}): QueryCriteria {
  const criteria: QueryCriteria = {
    ...(slot === undefined ? {} : { slot }),
    errorsOnly: Boolean(errorsOnly),
    includeAppDeviceErrors: Boolean(errorsOnly && !sources?.length),
  };
  if (sources && sources.length > 0) criteria.sources = sources;
  else if (criteria.errorsOnly) criteria.sources = ERROR_SOURCES;
  if (minLevel) criteria.minLevel = minLevel;
  if (typeof markerTs === 'number') criteria.markerTs = markerTs;
  if (typeof bundleMarkerTs === 'number') criteria.bundleMarkerTs = bundleMarkerTs;
  if (since !== undefined && since !== null && since !== '') {
    const parsed = parseSince(since);
    if (parsed.error) throw new Error(parsed.error);
    criteria.sinceTs = (typeof now === 'number' ? now : Date.now()) - (parsed.ms as number);
  }
  if (grep !== undefined && grep !== null && grep !== '') {
    const compiled = compileGrep(grep);
    if (compiled.error) throw new Error(compiled.error);
    criteria.grep = compiled.re;
  }
  return criteria;
}

export function logFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ndjson'))
    .map((e) => e.name)
    .toSorted();
}

export function fileSizes(dir: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of logFiles(dir)) {
    try {
      sizes[name] = statSync(join(dir, name)).size;
    } catch {}
  }
  return sizes;
}

export function readLogRecords(dir: string, include: (name: string) => boolean = () => true): NdjsonRecord[] {
  const all: NdjsonRecord[] = [];
  for (const name of logFiles(dir).filter(include)) {
    for (const record of readNdjsonGenerations(join(dir, name))) all.push(record);
  }
  return sortByTs(all);
}

export const NATIVE_CRASH_LOG_PREFIX = 'native-crash-';

/** Reads the CLI timeline with retained native crash records after other records at the same timestamp. */
export function readLogTimeline(dir: string, records?: NdjsonRecord[]): NdjsonRecord[] {
  const timeline = records ?? readLogRecords(dir, (name) => !name.startsWith(NATIVE_CRASH_LOG_PREFIX));
  return sortByTs([...timeline, ...readLogRecords(dir, (name) => name.startsWith(NATIVE_CRASH_LOG_PREFIX))]);
}

export function isExpoErrorContext(record: NdjsonRecord, event: unknown): boolean {
  if (record.src !== 'metro' || record.raw !== true || record.event !== event || typeof record.msg !== 'string') {
    return false;
  }
  return (
    /^Code: \S/.test(record.msg) ||
    /^\s*>?\s*\d+\s*\|/.test(record.msg) ||
    /^\s*\|\s*\^/.test(record.msg) ||
    /^Call Stack$/.test(record.msg) ||
    /^\s+.+\([^()]+:\d+:\d+\)\s*$/.test(record.msg) ||
    /^\s+at\s+\S+:\d+:\d+\s*$/.test(record.msg)
  );
}

function isExpoError(record: NdjsonRecord): boolean {
  return (
    record.src === 'metro' &&
    record.raw === true &&
    (record.level === 'error' || record.level === 'fatal') &&
    typeof record.msg === 'string'
  );
}

function isSameExpoStream(record: NdjsonRecord, error: NdjsonRecord): boolean {
  return record.src === 'metro' && record.raw === true && record.event === error.event;
}

type ExpoContextTarget = 'msg' | 'field';

function withExpoContext(record: NdjsonRecord, context: string[], into: ExpoContextTarget): NdjsonRecord {
  if (context.length === 0) return record;
  return into === 'msg' ? { ...record, msg: [record.msg, ...context].join('\n') } : { ...record, context };
}

/**
 * Adds the code frame and stack lines Expo printed after each Expo error record, either joined into
 * `msg` or as a `context` string array.
 */
export function attachExpoErrorContext(
  all: NdjsonRecord[],
  matched: NdjsonRecord[],
  into: ExpoContextTarget = 'msg',
): NdjsonRecord[] {
  return matched.map((record) => {
    if (!isExpoError(record)) return record;
    const index = all.findIndex(
      (entry) =>
        entry.ts === record.ts && entry.src === record.src && entry.msg === record.msg && entry.event === record.event,
    );
    if (index === -1) return record;
    const context: string[] = [];
    for (let i = index + 1; i < all.length; i += 1) {
      const next = all[i] as NdjsonRecord;
      if (!isSameExpoStream(next, record)) continue;
      if (!isExpoErrorContext(next, record.event)) break;
      context.push(next.msg as string);
    }
    return withExpoContext(record, context, into);
  });
}

function expoContextFollower(onRecord: (record: NdjsonRecord) => void, into: ExpoContextTarget) {
  let pending: { record: NdjsonRecord; context: string[]; queued: NdjsonRecord[] } | null = null;
  let grew = false;

  function flush(): void {
    if (!pending) return;
    const { record, context, queued } = pending;
    pending = null;
    onRecord(withExpoContext(record, context, into));
    for (const next of queued) onRecord(next);
  }

  function push(record: NdjsonRecord, matches: boolean): void {
    if (pending && isSameExpoStream(record, pending.record)) {
      if (!isExpoErrorContext(record, pending.record.event)) {
        flush();
      } else {
        pending.context.push(record.msg as string);
        if (matches) pending.queued.push(record);
        grew = true;
        return;
      }
    }
    if (pending) {
      if (matches) pending.queued.push(record);
      return;
    }
    if (matches && isExpoError(record)) {
      pending = { record, context: [], queued: [] };
      grew = true;
      return;
    }
    if (matches) onRecord(record);
  }

  function settle(): void {
    if (!grew) flush();
    grew = false;
  }

  return { push, settle, flush, pending: () => pending !== null };
}

function includeBareErrorContext(
  all: NdjsonRecord[],
  matched: NdjsonRecord[],
  launchTs: number | null,
  sinceTs: number | undefined,
): NdjsonRecord[] {
  const hasClientError = matched.some(
    (record) => record.src === 'client' && (record.level === 'error' || record.level === 'fatal'),
  );
  if (!hasClientError) return matched;
  const renderedContext: NdjsonRecord[] = [];
  for (const record of all) {
    if (record.src !== 'client' || record.event !== 'client_symbolication') continue;
    const ts = tsOf(record);
    if (launchTs !== null && (ts === null || ts <= launchTs)) continue;
    if (sinceTs !== undefined && (ts === null || ts < sinceTs)) continue;
    renderedContext.push({
      ...record,
      msg: `Metro symbolication context (not correlated to a specific client error)\n${String(record.msg ?? '')}`,
      errorContext: true,
    });
  }
  return sortByTs([...matched, ...renderedContext]);
}

function nativePlatform(record: NdjsonRecord): string | null {
  const platform = record.src === 'metro' && record.marker === true ? bundleMarkerPlatform(record) : record.platform;
  return platform === 'ios' || platform === 'android' ? platform : null;
}

function newestByPlatform(records: NdjsonRecord[], platformOf: (record: NdjsonRecord) => string | null) {
  const newest = new Map<string | null, number>();
  for (const record of records) {
    const ts = tsOf(record);
    if (ts === null) continue;
    const platform = platformOf(record);
    if (ts > (newest.get(platform) ?? -Infinity)) newest.set(platform, ts);
  }
  return newest;
}

function newestWhere(newest: Map<string | null, number>, include: (platform: string | null) => boolean) {
  let ts: number | undefined;
  for (const [platform, at] of newest) if (include(platform) && (ts === undefined || at > ts)) ts = at;
  return ts;
}

function isLaunchMarker(record: NdjsonRecord): boolean {
  return record.marker === true && record.src !== 'metro' && !isWebPageRecord(record);
}

function launchMarkersBySlot(records: NdjsonRecord[]): Map<unknown, number> {
  const markers = new Map<unknown, number>();
  for (const record of records) {
    if (record.marker !== true || record.src === 'metro' || isWebPageRecord(record)) continue;
    const ts = tsOf(record);
    const slot = record.slot ?? 'default';
    if (ts !== null && ts > (markers.get(slot) ?? -Infinity)) markers.set(slot, ts);
  }
  return markers;
}

export interface LogQueryOptions {
  slot?: string;
  sources?: string[];
  minLevel?: string;
  since?: string;
  grep?: string | RegExp;
  errorsOnly?: boolean;
  now?: number;
}

export interface LogQueryPlan {
  /** Whether a record belongs to the queried slot's timeline, before any other filter. */
  inTimeline: (record: NdjsonRecord) => boolean;
  matches: (record: NdjsonRecord) => boolean;
  launchTs: number | null;
  sinceTs: number | undefined;
  /**
   * Whether no record with a timestamp at most `maxTs`, or without one when `maxTs` is Infinity, can match.
   * `slots` lists every `slot ?? 'default'` value the records can carry; without it, a query that depends on
   * per-slot launch markers cannot rule out any timestamp.
   */
  excludesUpTo: (maxTs: number, slots?: ReadonlySet<unknown>) => boolean;
}

/** Decides which records a query matches from the timeline's marker records alone. */
export function planLogQuery(
  markers: readonly NdjsonRecord[],
  { slot, sources, minLevel, since, grep, errorsOnly, now }: LogQueryOptions = {},
): LogQueryPlan {
  const slotLaunched =
    slot !== undefined && markers.some((record) => isLaunchMarker(record) && (record.slot ?? 'default') === slot);
  const inTimeline = (record: NdjsonRecord) =>
    slot === undefined || (record.slot ?? 'default') === slot || (slotLaunched && isSharedRecord(record));
  const all = markers.filter((record) => record.marker === true && inTimeline(record));

  const { launchTs, bundleTs, pageLoadTs } = errorsOnly
    ? markerWindow(all)
    : { launchTs: null, bundleTs: null, pageLoadTs: null };
  const criteria = buildCriteria({
    slot,
    sources,
    minLevel,
    since,
    grep,
    errorsOnly,
    now,
    markerTs: launchTs === null ? undefined : launchTs,
    bundleMarkerTs: bundleTs === null ? undefined : bundleTs,
  });

  const slotMarkers = launchMarkersBySlot(all);
  const launches = newestByPlatform(
    all.filter((record) => record.src !== 'metro' && !isWebPageRecord(record)),
    (record) => (typeof record.platform === 'string' ? record.platform : null),
  );
  const bundles = newestByPlatform(
    all.filter((record) => record.src === 'metro'),
    bundleMarkerPlatform,
  );
  const slotPlatforms = slot === undefined ? [] : [...launches.keys()].filter((platform) => platform !== null);
  const windowStart = (record: NdjsonRecord): number | undefined => {
    if (pageLoadTs !== null && isWebPageRecord(record)) return pageLoadTs - 1;
    if (record.src !== 'metro' && record.src !== 'client') return slotMarkers.get(record.slot ?? 'default');
    const platform = nativePlatform(record);
    return (platform === null ? undefined : launches.get(platform)) ?? criteria.markerTs;
  };
  const otherPlatform = (record: NdjsonRecord) => {
    const platform = nativePlatform(record);
    return slotPlatforms.length > 0 && isSharedRecord(record) && platform !== null && !slotPlatforms.includes(platform);
  };
  const bundleWindowStart = (record: NdjsonRecord): number | undefined => {
    const platform = nativePlatform(record);
    return newestWhere(
      bundles,
      (marker) =>
        marker === null ||
        (platform ? marker === platform : slotPlatforms.length === 0 || slotPlatforms.includes(marker)),
    );
  };
  const lowestWindowStart = (slots: ReadonlySet<unknown> | undefined): number | undefined => {
    if (!criteria.errorsOnly) return undefined;
    const starts: number[] = [];
    if (pageLoadTs !== null) starts.push(pageLoadTs - 1);
    const kinds = criteria.sources ?? [];
    if (criteria.includeAppDeviceErrors || kinds.some((src) => src !== 'metro' && src !== 'client')) {
      const possible = slot !== undefined ? [slot] : slots ? [...slots] : null;
      if (!possible) return undefined;
      for (const value of possible) {
        const start = slotMarkers.get(value);
        if (start === undefined) return undefined;
        starts.push(start);
      }
    }
    if (kinds.includes('metro') || kinds.includes('client')) {
      if (criteria.markerTs === undefined) return undefined;
      starts.push(criteria.markerTs, ...launches.values());
    }
    return starts.length ? Math.min(...starts) : undefined;
  };
  return {
    inTimeline,
    matches: (record) =>
      inTimeline(record) &&
      !otherPlatform(record) &&
      recordMatches(record, { ...criteria, markerTs: windowStart(record), bundleMarkerTs: bundleWindowStart(record) }),
    launchTs,
    sinceTs: criteria.sinceTs,
    excludesUpTo: (maxTs, slots) => {
      if (criteria.sinceTs !== undefined && maxTs < criteria.sinceTs) return true;
      const start = lowestWindowStart(slots);
      return start !== undefined && maxTs <= start;
    },
  };
}

export function queryLogs({
  slot,
  dir,
  records,
  sources,
  minLevel,
  since,
  grep,
  tail,
  errorsOnly,
  errorContext,
  now,
}: LogQueryOptions & {
  dir?: string;
  records?: NdjsonRecord[];
  tail?: number;
  errorContext?: boolean;
} = {}): NdjsonRecord[] {
  const source = records ?? readLogRecords(dir as string);
  const plan = planLogQuery(
    source.filter((record) => record.marker === true),
    { slot, sources, minLevel, since, grep, errorsOnly, now },
  );
  const all = source.filter(plan.inTimeline);
  if (all.length === 0) return [];
  let matched = all.filter(plan.matches);
  if (typeof tail === 'number' && tail >= 0 && matched.length > tail) {
    matched = matched.slice(matched.length - tail);
  }
  return errorContext
    ? includeBareErrorContext(all, attachExpoErrorContext(all, matched), plan.launchTs, plan.sinceTs)
    : matched;
}

/** Queries the JSON timeline, including Expo context fields on errors as `stim logs --json` does. */
export function queryJsonLogs(options: Parameters<typeof queryLogs>[0] = {}): NdjsonRecord[] {
  const records = options.records ?? readLogTimeline(options.dir as string);
  const matched = queryLogs({ ...options, records, errorContext: false });
  return options.errorsOnly ? attachExpoErrorContext(records, matched, 'field') : matched;
}

export function tailRead(prev: TailState | null | undefined, size: number): { start: number; prev: TailState } {
  const state = prev && typeof prev.offset === 'number' ? prev : { offset: 0, partial: '' };
  if (size < state.offset) return { start: 0, prev: { offset: 0, partial: '' } };
  return { start: state.offset, prev: state };
}

export function advanceTail(
  prev: TailState | null | undefined,
  chunk: string | null | undefined,
  size: number,
): { state: TailState; records: NdjsonRecord[] } {
  const partialIn = prev && typeof prev.partial === 'string' ? prev.partial : '';
  const text = partialIn + (chunk || '');
  const lines = text.split('\n');
  const partial = lines.pop() as string;
  const records: NdjsonRecord[] = [];
  for (const line of lines) {
    const record = parseNdjsonLine(line);
    if (record) records.push(record);
  }
  return { state: { offset: size, partial }, records };
}

export function followLogs({
  dir,
  onRecord,
  criteria = {},
  intervalMs,
  offsets = null,
  errorContext,
}: {
  dir: string;
  onRecord: (record: NdjsonRecord) => void;
  criteria?: QueryCriteria;
  /** An explicit polling interval. Omit for filesystem hints with a ten-second repair scan. */
  intervalMs?: number;
  offsets?: Record<string, number> | null;
  /** Holds each Expo error until its code frame and stack stop growing, then attaches them. */
  errorContext?: ExpoContextTarget;
}): () => void {
  const follower = errorContext ? expoContextFollower(onRecord, errorContext) : null;
  const state = new Map<string, TailState>();
  const decoders = new Map<string, StringDecoder>();
  let stopped = false;
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  for (const [name, size] of Object.entries(offsets || fileSizes(dir))) {
    state.set(name, { offset: size, partial: '' });
    decoders.set(name, new StringDecoder('utf8'));
  }

  function emit(records: NdjsonRecord[]): void {
    for (const record of records) {
      if (stopped) break;
      const matches = recordMatches(record, criteria);
      if (follower) follower.push(record, matches);
      else if (matches) onRecord(record);
    }
  }

  function drainRotated(name: string, entry: TailState): void {
    const path = rotatedLogPath(join(dir, name));
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    const decoder = decoders.get(name) ?? new StringDecoder('utf8');
    emit(advanceTail(entry, readChunk(path, decoder, entry.offset, size) + decoder.end(), size).records);
  }

  function pollFile(name: string): void {
    const path = join(dir, name);
    const size = statSync(path).size;
    const entry = state.get(name);
    // https://github.com/appandflow/stim/issues/3899: larger replacements still use the previous byte offset.
    if (entry && size < entry.offset) drainRotated(name, entry);
    const { start, prev } = tailRead(entry, size);
    if (prev !== entry) decoders.set(name, new StringDecoder('utf8'));
    if (!decoders.has(name)) decoders.set(name, new StringDecoder('utf8'));

    const next = advanceTail(prev, readChunk(path, decoders.get(name)!, start, size), size);
    state.set(name, next.state);
    emit(next.records);
  }

  function poll() {
    if (stopped) return;
    for (const name of logFiles(dir)) {
      if (stopped) break;
      try {
        pollFile(name);
      } catch {}
    }
    if (intervalMs !== undefined) follower?.settle();
    else if (!contextTimer && follower?.pending()) {
      follower.settle();
      contextTimer = setTimeout(settleContext, 500);
    }
  }

  function settleContext(): void {
    contextTimer = undefined;
    if (stopped) return;
    follower?.settle();
    if (follower?.pending()) contextTimer = setTimeout(settleContext, 500);
  }

  let watcher: FSWatcher | undefined;
  let directory: { dev: number; ino: number } | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let repairTimer: ReturnType<typeof setTimeout> | undefined;

  function closeWatch(): void {
    const previous = watcher;
    watcher = undefined;
    directory = undefined;
    previous?.close();
  }

  function schedulePoll(): void {
    if (stopped || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      poll();
    });
  }

  function sameDirectory(): boolean {
    if (!watcher || !directory) return false;
    try {
      const current = statSync(dir);
      return current.dev === directory.dev && current.ino === directory.ino;
    } catch {
      return false;
    }
  }

  function attachWatch(): boolean {
    if (stopped || watcher) return false;
    try {
      const current = statSync(dir);
      const next = watch(dir, { persistent: false }, (event) => {
        if (stopped) return;
        if (event === 'rename' && !sameDirectory()) {
          closeWatch();
          const attached = attachWatch();
          armRepair(attached ? 500 : undefined);
        }
        schedulePoll();
      });
      watcher = next;
      directory = current;
      const lost = () => {
        if (watcher !== next) return;
        closeWatch();
        armRepair();
      };
      next.once('error', lost);
      next.once('close', lost);
      return true;
    } catch {}
    return false;
  }

  function armRepair(delay = watcher ? 10_000 : 500): void {
    clearTimeout(repairTimer);
    if (stopped) return;
    // Node fs.watch can lose changes or keep a replaced inode: https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats
    repairTimer = setTimeout(() => {
      let attached = false;
      if (!sameDirectory()) {
        closeWatch();
        attached = attachWatch();
      }
      poll();
      armRepair(attached ? 500 : undefined);
    }, delay);
  }

  const timer = intervalMs === undefined ? undefined : setInterval(poll, intervalMs);
  if (intervalMs === undefined) {
    attachWatch();
    poll();
    // macOS exposes no watch-ready event: https://github.com/nodejs/node/issues/52601
    armRepair(500);
  }
  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(repairTimer);
    clearTimeout(contextTimer);
    clearImmediate(scheduled);
    closeWatch();
    follower?.flush();
  };
}

function readChunk(path: string, decoder: StringDecoder, start: number, size: number): string {
  if (size <= start) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(size - start);
    const read = readSync(fd, buf, 0, size - start, start);
    return decoder.write(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

function tsOf(record: NdjsonRecord | null | undefined): number | null {
  return typeof record?.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null;
}

export function sortByTs(records: NdjsonRecord[]): NdjsonRecord[] {
  return records.toSorted((a, b) => {
    const ta = tsOf(a);
    const tb = tsOf(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}
