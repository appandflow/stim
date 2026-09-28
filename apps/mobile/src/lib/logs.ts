import { relativeTo, tildeHome } from '@/lib/paths';
import type { EnvironmentState, LogFilter, LogRecord, LogSource, StackFrame } from '@/protocol/types';

/**
 * The source chips of the Logs screen. iOS, Android and Web split the `device` source by the records' `platform`,
 * which the server cannot filter on, so the screen filters those on the phone.
 */
export type LogChip = 'metro' | 'client' | 'ios' | 'android' | 'web' | 'build' | 'agent';

export const CHIPS: { chip: LogChip; label: string; source: LogSource }[] = [
  { chip: 'metro', label: 'Metro', source: 'metro' },
  { chip: 'client', label: 'App', source: 'client' },
  { chip: 'ios', label: 'iOS', source: 'device' },
  { chip: 'android', label: 'Android', source: 'device' },
  { chip: 'web', label: 'Web', source: 'device' },
  { chip: 'build', label: 'Build', source: 'build' },
  { chip: 'agent', label: 'Agent', source: 'agent' },
];

const DEVICE_CHIPS: LogChip[] = ['ios', 'android', 'web'];
const SOURCE_COUNT = new Set(CHIPS.map((c) => c.source)).size;

export type Severity = 'all' | 'errors' | 'warnings';

export const MAX_RECORDS = 5000;

export interface LogFilterState {
  /** Empty shows every source. */
  chips: LogChip[];
  severity: Severity;
  grep: string;
  slot: string | null;
}

export const DEFAULT_FILTER: LogFilterState = { chips: [], severity: 'all', grep: '', slot: null };

/** The filter the Logs screen opens with, from its route params. */
export function initialFilter(params: { errors?: string; source?: string; slot?: string }): LogFilterState {
  const chip = CHIPS.find((c) => c.chip === params.source)?.chip;
  return {
    ...DEFAULT_FILTER,
    severity: params.errors === '1' ? 'errors' : 'all',
    chips: chip ? [chip] : [],
    slot: params.slot || null,
  };
}

/**
 * The same arguments apps/desktop passes to `stim logs`: every source selected sends no `sources`, so Errors keeps
 * the CLI's default scope. Warnings asks for `warn` and up; `showsEntry` keeps the warnings.
 */
export function logFilter(workspace: string, state: LogFilterState, tail = MAX_RECORDS): LogFilter {
  const filter: LogFilter = { workspace, tail };
  const sources = [...new Set(CHIPS.filter((c) => state.chips.includes(c.chip)).map((c) => c.source))];
  if (sources.length > 0 && sources.length < SOURCE_COUNT) filter.sources = sources;
  if (state.severity === 'warnings') filter.level = 'warn';
  if (state.severity === 'errors') filter.errors = true;
  if (state.grep.trim() !== '') filter.grep = state.grep.trim();
  if (state.slot) filter.slot = state.slot;
  return filter;
}

function recordPlatform(record: LogRecord): string | null {
  return typeof record.platform === 'string' ? record.platform : null;
}

/** The chip a record belongs to; null for a device record with no platform Stim knows. */
export function chipOf(record: LogRecord): LogChip | null {
  if (record.src !== 'device') return CHIPS.find((c) => c.source === record.src)?.chip ?? null;
  const platform = recordPlatform(record);
  return DEVICE_CHIPS.find((c) => c === platform) ?? null;
}

/** The part of the filter the server cannot apply: the platform of device records, and warnings without errors. */
export function showsEntry(state: LogFilterState, entry: LogEntry): boolean {
  const { lead } = entry;
  if (state.severity === 'warnings' && lead.level !== 'warn') return false;
  if (lead.src !== 'device' || state.chips.length === 0) return true;
  const chip = chipOf(lead);
  return chip === null || state.chips.includes(chip);
}

/**
 * The chips worth showing for a workspace: the sources its status says it runs, the ones its records came from,
 * and the ones selected.
 */
export function presentChips(
  env: EnvironmentState | undefined,
  seen: ReadonlySet<LogChip>,
  selected: readonly LogChip[],
): LogChip[] {
  const present = new Set<LogChip>([...seen, ...selected]);
  if (env?.metro) present.add('metro').add('client');
  if (env?.ios || env?.slots?.some((s) => s.ios)) present.add('ios');
  if (env?.android || env?.slots?.some((s) => s.android)) present.add('android');
  if (env?.web) present.add('web');
  if (env?.build || env?.lastBuilds?.ios || env?.lastBuilds?.android) present.add('build');
  return CHIPS.map((c) => c.chip).filter((c) => present.has(c));
}

const BUNDLE_PAIRS: Record<string, { start: string; id: string }> = {
  bundle_build_done: { start: 'bundle_build_started', id: 'buildID' },
  bundle_response_finished: { start: 'bundle_response_started', id: 'requestId' },
};

/** How long the newest finished Metro bundle took, from its start and finish records; null without both. */
export function lastBundleMs(records: readonly LogRecord[]): number | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const done = records[i]!;
    const pair = done.src === 'metro' && typeof done.event === 'string' ? BUNDLE_PAIRS[done.event] : undefined;
    if (!pair || typeof done[pair.id] !== 'string') continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const start = records[j]!;
      if (start.src === 'metro' && start.event === pair.start && start[pair.id] === done[pair.id])
        return done.ts - start.ts;
    }
  }
  return null;
}

export function appendRecords(existing: LogRecord[], incoming: LogRecord[], max = MAX_RECORDS): LogRecord[] {
  if (incoming.length === 0) return existing;
  const next = existing.concat(incoming);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function firstLine(message: string): string {
  const i = message.indexOf('\n');
  return i < 0 ? message : message.slice(0, i);
}

/** The same `at fn (file:line:column)` lines `stim logs` prints under a record. */
export function stackLines(stack: unknown): string[] {
  if (!Array.isArray(stack)) return [];
  return (stack as StackFrame[]).flatMap((frame) => {
    if (!frame || typeof frame !== 'object') return [];
    const where = [frame.file, frame.line, frame.column]
      .filter((p) => p !== undefined && p !== null && p !== '')
      .join(':');
    if (frame.fn && where) return [`at ${frame.fn} (${where})`];
    if (frame.fn) return [`at ${frame.fn}`];
    return where ? [`at ${where}`] : [];
  });
}

/** One row of the log list: the records of one failure, led by the record that carries its message. */
export interface LogEntry {
  key: string;
  lead: LogRecord;
  /** Other headline records of the same failure, such as `Bundling failed` and the failed bundle response. */
  related: LogRecord[];
  /** Lines Expo printed under the lead's message: its code frame and parser stack. */
  context: string[];
}

export interface PreviewFrame {
  fn: string;
  where: string;
  /** Code in the workspace, outside `node_modules`. */
  app: boolean;
}

export interface StackPreview {
  frames: PreviewFrame[];
  /** Frames left out of `frames`. */
  hidden: number;
  /** Whether every hidden frame is framework code. */
  hiddenFramework: boolean;
}

const PREVIEW_FRAMES = 3;

function scriptName(file: string): string | null {
  if (!/^https?:\/\//.test(file)) return null;
  const path = file.split(/[?#]/)[0]!;
  return path.slice(path.lastIndexOf('/') + 1) || null;
}
const PACKAGE = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;

/**
 * The top frames of a stack for a collapsed row: the workspace's own frames, and at most one framework frame, which
 * shows as its package.
 */
export function stackPreview(stack: unknown, root: string, home: string | null | undefined): StackPreview | null {
  if (!Array.isArray(stack)) return null;
  const all = (stack as StackFrame[]).flatMap((frame): PreviewFrame[] => {
    if (!frame || typeof frame !== 'object') return [];
    const file = typeof frame.file === 'string' ? frame.file : '';
    const relative = relativeTo(file, root);
    const app = relative !== file && !relative.includes('node_modules/');
    const where = app
      ? [relative, frame.line].filter((p) => p !== undefined && p !== null && p !== '').join(':')
      : ([...file.matchAll(PACKAGE)].at(-1)?.[1] ?? scriptName(file) ?? tildeHome(file, home));
    const fn = typeof frame.fn === 'string' ? frame.fn : '';
    return fn || where ? [{ fn, where, app }] : [];
  });
  if (all.length === 0) return null;
  const shown = new Set<number>();
  let framework = false;
  all.forEach((frame, i) => {
    if (shown.size >= PREVIEW_FRAMES) return;
    if (frame.app) shown.add(i);
    else if (!framework) {
      framework = true;
      shown.add(i);
    }
  });
  return {
    frames: all.filter((_, i) => shown.has(i)),
    hidden: all.length - shown.size,
    hiddenFramework: all.every((frame, i) => shown.has(i) || !frame.app),
  };
}

const BUNDLE_LINE_WINDOW_MS = 1000;
const BUNDLE_RESPONSE_WINDOW_MS = 2000;

function isError(record: LogRecord): boolean {
  return record.level === 'error' || record.level === 'fatal';
}

function isExpoLine(record: LogRecord): boolean {
  return record.src === 'metro' && record.raw === true && record.event === 'expo_stdout';
}

const CODE_FRAME_LINE = [/^\s*>?\s*\d+\s*\|/, /^\s*\|\s*\^/];
const EXPO_CONTEXT_LINE = [
  /^Code: \S/,
  ...CODE_FRAME_LINE,
  /^Call Stack$/,
  /^\s+.+\([^()]+:\d+:\d+\)\s*$/,
  /^\s+at\s+\S+:\d+:\d+\s*$/,
];

function isCodeFrameLine(line: string): boolean {
  return CODE_FRAME_LINE.some((re) => re.test(line));
}

/** The lines `stim logs --errors` attaches to an Expo error (`isExpoErrorContext` in `@stim-cli/core`). */
function isExpoContext(record: LogRecord): boolean {
  return isExpoLine(record) && typeof record.msg === 'string' && EXPO_CONTEXT_LINE.some((re) => re.test(record.msg));
}

/**
 * The indexes of the code frame and stack lines Expo printed after the error at `at`: Stim's Expo
 * supervisor records each stdout line on its own. Other Metro records, such as Stim's bundle response
 * records, can land between them.
 */
function contextAfter(records: LogRecord[], at: number, taken?: Set<number>): number[] {
  const context: number[] = [];
  for (let i = at + 1; i < records.length; i += 1) {
    const next = records[i]!;
    if (next.src !== 'metro' || taken?.has(i)) continue;
    if (!isExpoLine(next)) continue;
    if (!isExpoContext(next)) break;
    context.push(i);
  }
  return context;
}

/** The context lines of `lead` in `records`, for an entry whose context the current filter left out. */
export function expoContext(records: LogRecord[], lead: LogRecord): LogRecord[] {
  const at = records.findIndex(
    (r) => r.ts === lead.ts && r.src === lead.src && r.event === lead.event && r.msg === lead.msg,
  );
  return at < 0 ? [] : contextAfter(records, at).map((i) => records[i]!);
}

function nextExpoLine(records: LogRecord[], from: number, taken: Set<number>): number {
  for (let i = from; i < records.length; i += 1) {
    if (!taken.has(i) && isExpoLine(records[i]!)) return i;
  }
  return -1;
}

/**
 * Collapses the records of one Metro failure into one entry. In Expo's dev server a failed bundle is a
 * `Bundling failed` marker line, the error line with its code frame lines, and a failed bundle
 * response from Stim's middleware. Every other record is its own entry.
 */
export function groupRecords(records: LogRecord[]): LogEntry[] {
  const taken = new Set<number>();
  const groups: { indexes: number[]; lead: number; context: number[] }[] = [];

  for (let i = 0; i < records.length; i += 1) {
    if (taken.has(i)) continue;
    const record = records[i]!;
    taken.add(i);
    const group = { indexes: [i], lead: i, context: [] as number[] };
    groups.push(group);

    if (isExpoLine(record) && isError(record)) {
      if (record.marker === true) {
        const j = nextExpoLine(records, i + 1, taken);
        const next = j < 0 ? null : records[j]!;
        if (next && isError(next) && next.marker !== true && next.ts - record.ts <= BUNDLE_LINE_WINDOW_MS) {
          taken.add(j);
          group.indexes.push(j);
          group.lead = j;
        }
      }
      for (const k of contextAfter(records, group.lead, taken)) {
        taken.add(k);
        group.context.push(k);
      }
    }
  }

  const failures = groups.filter((g) => {
    const first = records[g.indexes[0]!]!;
    return isExpoLine(first) && first.marker === true && isError(first);
  });
  const responses = groups.filter((g) => records[g.lead]!.event === 'bundle_response_failed');
  const merged = new Set<(typeof groups)[number]>();
  const answered = new Set<(typeof groups)[number]>();
  for (const response of responses) {
    const { ts, platform } = records[response.lead]!;
    const distance = (g: (typeof groups)[number]) => Math.abs(records[g.indexes[0]!]!.ts - ts);
    const target = failures
      .filter(
        (g) =>
          !answered.has(g) &&
          distance(g) <= BUNDLE_RESPONSE_WINDOW_MS &&
          (typeof platform !== 'string' ||
            records[g.indexes[0]!]!.msg.toLowerCase().startsWith(`${platform.toLowerCase()} `)),
      )
      .sort((a, b) => distance(a) - distance(b))[0];
    if (!target) continue;
    target.indexes.push(response.lead);
    answered.add(target);
    merged.add(response);
  }

  const seen = new Map<number, number>();
  return groups
    .filter((g) => !merged.has(g))
    .map((g) => {
      const indexes = [...g.indexes].sort((a, b) => a - b);
      const first = records[indexes[0]!]!;
      const ordinal = seen.get(first.ts) ?? 0;
      seen.set(first.ts, ordinal + 1);
      const lead = records[g.lead]!;
      return {
        key: `${first.ts}:${ordinal}`,
        lead,
        related: indexes.filter((i) => i !== g.lead).map((i) => records[i]!),
        context:
          g.context.length > 0 || !Array.isArray(lead.context) ? g.context.map((i) => records[i]!.msg) : lead.context,
      };
    });
}

/**
 * An Expo error line whose code frame lines the current filter left out: Warnings, a search, or Errors from a
 * Stim that does not attach them as `context`.
 */
export function needsContext(entry: LogEntry): boolean {
  return isExpoLine(entry.lead) && isError(entry.lead) && entry.context.length === 0;
}

/** What a log entry shows: its message first, then where it happened, then the code frame. */
export interface EntryView {
  title: string;
  location: string | null;
  codeFrame: string[];
  /** The rest of the message, the other records of the entry, and the stack. */
  details: string[];
}

const BABEL_ERROR =
  /^(?:(?<type>[A-Z][A-Za-z]*Error): )?(?<file>[^\s:]*\/[^\s:]*|[^\s:/]+\.[A-Za-z]+): (?<message>.*?)(?: \((?<line>\d+):(?<column>\d+)\))?$/;

export function viewEntry(entry: LogEntry, root: string, home: string | null | undefined): EntryView {
  const clean = (text: string) => tildeHome(relativeTo(text, root), home);
  const lines = (typeof entry.lead.msg === 'string' ? entry.lead.msg : '').split('\n');
  let head = (lines.shift() ?? '').replace(/^\s*ERROR\s+/, '');
  const bracketed = /^\[(.*)\]$/.exec(head);
  if (bracketed) head = bracketed[1]!;

  let title = clean(head);
  let location: string | null = null;
  const babel = BABEL_ERROR.exec(head);
  if (babel?.groups) {
    const { type, file, message, line, column } = babel.groups;
    title = type ? `${type}: ${message}` : message!;
    location = clean(file!) + (line ? `:${line}:${column}` : '');
  }

  const codeFrame: string[] = [];
  const details = entry.related.map((record) => clean(firstLine(record.msg)));
  for (const line of [...lines, ...entry.context]) {
    if (isCodeFrameLine(line)) codeFrame.push(line);
    else if (line.trim() !== '') details.push(clean(line));
  }
  details.push(...stackLines(entry.lead.stack).map(clean));
  if (entry.lead.src === 'agent') details.push(...agentDetails(entry.lead.details));
  return { title, location, codeFrame, details };
}

function agentDetails(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  return Object.entries(details).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

/** What Copy puts on the clipboard: the message and where it happened. */
export function copyText(view: EntryView): string {
  return view.location ? `${view.title}\n${view.location}` : view.title;
}

/** What Share sends: the whole entry. */
export function shareText(view: EntryView, entry: LogEntry, workspace: string): string {
  const time = new Date(entry.lead.ts).toISOString();
  const parts = [copyText(view)];
  if (view.codeFrame.length > 0) parts.push(view.codeFrame.join('\n'));
  if (view.details.length > 0) parts.push(view.details.join('\n'));
  parts.push(`${entry.lead.src} ${entry.lead.level} at ${time} in ${workspace}`);
  return parts.join('\n\n');
}

export const AGENT_FEED_SIZE = 5;

export function agentFeedFilter(workspace: string, slot: string): LogFilter {
  return { workspace, sources: ['agent'], slot, tail: 200 };
}

export interface AgentAction {
  key: number;
  record: LogRecord;
}

export function agentActions(existing: AgentAction[], incoming: LogRecord[], deviceId: string): AgentAction[] {
  const mine = incoming.filter((record) => record.src === 'agent' && record.deviceId === deviceId);
  if (mine.length === 0) return existing;
  const base = existing[0]?.key ?? 0;
  const added = mine.map((record, i) => ({ key: base + i + 1, record })).reverse();
  return added.concat(existing).slice(0, AGENT_FEED_SIZE);
}
