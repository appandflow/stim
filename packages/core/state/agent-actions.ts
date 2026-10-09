import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NdjsonRecord } from './ndjson.ts';

interface DeviceTarget {
  platform: 'ios' | 'android';
  id: string;
  slot: string;
  name?: string;
}

export type AgentTarget =
  | DeviceTarget
  | { platform: 'macos'; id: string; slot: string; bundleId: string; launchedAt: number };

interface AgentEvent {
  ts: number;
  session: string;
  kind: 'action.recorded' | 'request.finished' | 'request.started';
  command: string;
  summary: string;
  failed: boolean;
  details: Record<string, unknown> | null;
  requestId: string | null;
}

interface ParsedAgentEvents {
  events: AgentEvent[];
  started: [string, number][];
  finished: string[];
  session: string | null;
  unknownVersion: { version: unknown; ts: number | null } | null;
}

const EVENTS_VERSION = 1;
const MAX_OPEN_REQUESTS = 64;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAgentEvents(lines: readonly string[]): ParsedAgentEvents {
  const events: AgentEvent[] = [];
  const started: [string, number][] = [];
  const finished: string[] = [];
  let session: string | null = null;
  let unknownVersion: ParsedAgentEvents['unknownVersion'] = null;
  for (const line of lines) {
    let entry: Record<string, unknown> | null;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const ts = typeof entry.ts === 'string' ? Date.parse(entry.ts) : Number.NaN;
    if (entry.version !== EVENTS_VERSION) {
      unknownVersion ??= { version: entry.version, ts: Number.isFinite(ts) ? ts : null };
      continue;
    }
    if (typeof entry.session === 'string') session ??= entry.session;
    const { kind, command, summary } = entry;
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : null;
    if (kind === 'request.started' && requestId && Number.isFinite(ts)) started.push([requestId, ts]);
    const scopeChange = kind === 'request.started' && (command === 'open' || command === 'close');
    if (kind !== 'action.recorded' && kind !== 'request.finished' && !scopeChange) continue;
    const failed = kind === 'request.finished' && entry.status === 'error';
    if (kind === 'request.finished' && !failed) {
      if (requestId) finished.push(requestId);
      continue;
    }
    if (!Number.isFinite(ts) || typeof entry.session !== 'string' || typeof command !== 'string') continue;
    if (typeof summary !== 'string' && !scopeChange) continue;
    events.push({
      ts,
      session: entry.session,
      kind: kind as AgentEvent['kind'],
      command,
      summary: typeof summary === 'string' ? summary : '',
      failed,
      details: object(entry.details),
      requestId,
    });
  }
  return { events, started, finished, session, unknownVersion };
}

interface RunnerSpan {
  deviceId: string;
  from: number;
}

const RUNNER_DEVICE =
  /-destination\s+"?platform=iOS Simulator,id=([^",\s]+)|AgentDeviceRunner\.env\.session-(.+?)-owner-/;
const LOG_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})?(\d{2})?\b/;

function logTime(line: string): number | null {
  const match = LOG_TIME.exec(line);
  if (!match) return null;
  const [, date, time, fraction = '', offsetHours, offsetMinutes] = match;
  const offset = offsetHours && offsetMinutes ? `${offsetHours}:${offsetMinutes}` : '';
  const at = Date.parse(`${date}T${time}${fraction.slice(0, 4)}${offset}`);
  return Number.isFinite(at) ? at : null;
}

function parseRunnerSpans(text: string): RunnerSpan[] {
  const spans: RunnerSpan[] = [];
  let pending: string | null = null;
  for (const line of text.split('\n')) {
    const device = RUNNER_DEVICE.exec(line);
    if (device) {
      pending = device[1] ?? device[2] ?? null;
      continue;
    }
    if (pending === null) continue;
    const at = logTime(line);
    if (at === null) continue;
    if (spans.at(-1)?.deviceId !== pending) spans.push({ deviceId: pending, from: spans.length ? at : -Infinity });
    pending = null;
  }
  return spans;
}

function sessionSpans(runner: readonly RunnerSpan[], closes: readonly number[]): RunnerSpan[] {
  return runner.map((span, i) => {
    const previous = runner[i - 1]?.from ?? -Infinity;
    const close = closes.findLast((at) => at > previous && at < span.from);
    return close === undefined ? span : { ...span, from: close + 1 };
  });
}

function spanDevice(spans: readonly RunnerSpan[], ts: number): string | null {
  let device: string | null = null;
  for (const span of spans) if (span.from <= ts) device = span.deviceId;
  return device;
}

type Platform = AgentTarget['platform'];

function platformOf(event: AgentEvent): 'ios' | 'android' | undefined {
  const platform = event.details?.platform;
  return platform === 'ios' || platform === 'android' ? platform : undefined;
}

function agentRecord(
  event: AgentEvent,
  deviceId: string | null,
  target: { platform?: Platform; slot: string },
  startedAt?: number,
): NdjsonRecord {
  return {
    ts: event.ts,
    ...(startedAt !== undefined && startedAt <= event.ts ? { startedAt } : {}),
    src: 'agent',
    level: event.failed ? 'error' : 'info',
    msg: event.summary,
    event: event.failed ? 'agent_failed' : 'agent_action',
    command: event.command,
    session: event.session,
    ...(target.platform ? { platform: target.platform } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(target.slot === 'default' ? {} : { slot: target.slot }),
    ...(event.details ? { details: event.details } : {}),
  };
}

function formatUnknownRecord(
  session: string,
  unknown: NonNullable<ParsedAgentEvents['unknownVersion']>,
  target: { platform?: Platform; slot: string },
  now: number,
): NdjsonRecord {
  return {
    ts: unknown.ts ?? now,
    src: 'agent',
    level: 'warn',
    msg: `agent-device session ${session} records events in an unrecognized format (version ${JSON.stringify(unknown.version) ?? 'missing'}); its actions are not shown.`,
    event: 'agent_format_unknown',
    session,
    ...(target.platform ? { platform: target.platform } : {}),
    ...(target.slot === 'default' ? {} : { slot: target.slot }),
  };
}

function readCompleteLines(
  path: string,
  start: number,
): { text: string; next: number; size: number; identity: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd, { bigint: true });
    const size = Number(stat.size);
    const identity = `${stat.dev}:${stat.ino}`;
    if (size <= start) return { text: '', next: start, size, identity };
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    return { text: end < 0 ? '' : buffer.toString('utf8', 0, end + 1), next: start + end + 1, size, identity };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface SessionCursor {
  offset: number;
  identity?: string;
  closes: number[];
  runner: { size: number; spans: RunnerSpan[] } | null;
  session: string | null;
  unknownReported: boolean;
  platform?: 'ios' | 'android';
  started: Map<string, number>;
  macos: boolean;
  bundleId: string | null;
  closing: string | null;
}

function trackMacosOpen(cursor: SessionCursor, event: AgentEvent, unknownVersion: boolean): void {
  const flags = object(event.details?.flags);
  if (!event.failed) cursor.macos = event.details?.platform === 'macos' || flags?.platform === 'macos';
  cursor.bundleId =
    cursor.macos &&
    !event.failed &&
    !unknownVersion &&
    flags?.surface === 'app' &&
    typeof event.details?.appBundleId === 'string'
      ? event.details.appBundleId
      : null;
}

export interface AgentActionReaderOptions {
  sessionsDirs: readonly string[] | (() => readonly string[]);
  /** Re-resolved on every read, so a follower picks up a native launch that starts or restarts later. */
  targets?: AgentTarget[] | (() => AgentTarget[]);
  sinceTs?: number;
  now?: () => number;
  claimedDevice?: (session: string, sessionsDir: string) => string | null;
}

/**
 * Reads agent-device session actions incrementally from the supplied sessions directories. With targets,
 * records are restricted to those devices; without targets, retained session metadata supplies attribution.
 * Missing directories and unreadable files yield no records.
 */
export function createAgentActionReader({
  sessionsDirs,
  targets: resolveTargets,
  sinceTs = -Infinity,
  now = Date.now,
  claimedDevice = () => null,
}: AgentActionReaderOptions): () => NdjsonRecord[] {
  const cursors = new Map<string, SessionCursor>();

  return () => {
    const targets = typeof resolveTargets === 'function' ? resolveTargets() : resolveTargets;
    if (targets && !targets.length) return [];
    const byId = new Map(targets?.map((target) => [target.id, target]));
    const macosByBundle = new Map(
      targets?.flatMap((target) => (target.platform === 'macos' ? [[target.bundleId, target] as const] : [])),
    );
    const sessionDirs = (typeof sessionsDirs === 'function' ? sessionsDirs() : sessionsDirs).flatMap((sessionsDir) => {
      try {
        return readdirSync(sessionsDir).map((name) => ({ name, sessionsDir, dir: join(sessionsDir, name) }));
      } catch {
        return [];
      }
    });

    const out: NdjsonRecord[] = [];
    for (const { name, sessionsDir, dir } of sessionDirs) {
      const eventsPath = join(dir, 'events.ndjson');
      const lines: string[] = [];
      let cursor = cursors.get(dir);
      if (!cursor) {
        try {
          if (statSync(eventsPath).mtimeMs < sinceTs) continue;
        } catch {
          continue;
        }
        cursor = {
          offset: 0,
          closes: [],
          runner: null,
          session: null,
          unknownReported: false,
          started: new Map(),
          macos: false,
          bundleId: null,
          closing: null,
        };
        cursors.set(dir, cursor);
        try {
          lines.push(...readFileSync(`${eventsPath}.1`, 'utf8').split('\n'));
        } catch {}
      }
      // agent-device rotates events.ndjson to events.ndjson.1 at AGENT_DEVICE_EVENT_LOG_MAX_BYTES (5 MiB by
      // default). A rotation between two reads restarts at the new file; the unread tail of .1 is skipped.
      let chunk = readCompleteLines(eventsPath, cursor.offset);
      if (chunk && (chunk.size < cursor.offset || (cursor.identity && chunk.identity !== cursor.identity))) {
        cursor.bundleId = null;
        chunk = readCompleteLines(eventsPath, 0);
      }
      if (!chunk) continue;
      cursor.identity = chunk.identity;
      cursor.offset = chunk.next;
      lines.push(...chunk.text.split('\n'));
      const parsed = parseAgentEvents(lines);
      for (const [requestId, at] of parsed.started) cursor.started.set(requestId, at);
      cursor.session ??= parsed.session;
      const session = cursor.session;
      const matched = new Map(
        parsed.events.flatMap((event) =>
          event.requestId && cursor.started.has(event.requestId)
            ? [[event.requestId, cursor.started.get(event.requestId)!] as const]
            : [],
        ),
      );
      const failed = parsed.events.flatMap((event) => (event.failed && event.requestId ? [event.requestId] : []));
      for (const requestId of [...parsed.finished, ...failed]) cursor.started.delete(requestId);
      for (const requestId of [...cursor.started.keys()].slice(0, -MAX_OPEN_REQUESTS)) cursor.started.delete(requestId);
      if (!parsed.events.length && !parsed.unknownVersion) continue;

      const runnerPath = join(dir, 'runner.log');
      let runnerSize = -1;
      try {
        runnerSize = statSync(runnerPath).size;
      } catch {}
      if (cursor.runner?.size !== runnerSize) {
        let text = '';
        try {
          text = readFileSync(runnerPath, 'utf8');
        } catch {}
        cursor.runner = { size: runnerSize, spans: parseRunnerSpans(text) };
      }
      for (const event of parsed.events)
        if (event.command === 'close' && event.kind === 'action.recorded') cursor.closes.push(event.ts);
      // agent-device starts an iOS runner lazily, on the first command that needs it, so the runner log dates a
      // device change late. A session that closes and reopens on another simulator changes device at the close.
      const spans = sessionSpans(cursor.runner.spans, cursor.closes);
      const deviceAt = (ts: number) =>
        spans.length ? spanDevice(spans, ts) : session && claimedDevice(session, sessionsDir);
      cursor.platform ??= parsed.events.map(platformOf).find((platform) => platform !== undefined);
      cursor.platform ??= spans.length ? 'ios' : undefined;
      // agent-device session files retain no Stim slot assignment; live targets get it from the workspace registry.
      const retainedTarget = () => ({
        platform: cursor.platform,
        slot: 'default',
      });

      if (parsed.unknownVersion && !cursor.unknownReported) {
        const deviceId = spans.at(-1)?.deviceId ?? (session && claimedDevice(session, sessionsDir));
        const target = !targets
          ? retainedTarget()
          : cursor.macos
            ? cursor.bundleId
              ? macosByBundle.get(cursor.bundleId)
              : undefined
            : deviceId
              ? byId.get(deviceId)
              : undefined;
        if (target) {
          cursor.unknownReported = true;
          out.push(formatUnknownRecord(session ?? name, parsed.unknownVersion, target, now()));
        }
      }
      if (parsed.unknownVersion) cursor.bundleId = null;
      for (const event of parsed.events) {
        if (event.kind === 'request.started') {
          cursor.closing = event.command === 'close' ? cursor.bundleId : null;
          cursor.bundleId = null;
          continue;
        }
        if (targets && event.command === 'open') trackMacosOpen(cursor, event, Boolean(parsed.unknownVersion));
        if (targets && cursor.macos) {
          // agent-device's screenshot event omits its per-command surface override.
          if (event.command === 'screenshot') continue;
          const bundleId = cursor.bundleId ?? (event.command === 'close' ? cursor.closing : null);
          cursor.closing = null;
          const target = bundleId ? macosByBundle.get(bundleId) : undefined;
          const startedAt = event.requestId ? matched.get(event.requestId) : undefined;
          if (
            target?.platform === 'macos' &&
            event.ts >= Math.max(sinceTs, target.launchedAt) &&
            (startedAt ?? event.ts) >= target.launchedAt
          )
            out.push(agentRecord(event, target.id, target, startedAt));
          if (event.command === 'close') cursor.bundleId = null;
          continue;
        }
        if (event.ts < sinceTs) continue;
        if (!targets) cursor.platform = platformOf(event) ?? cursor.platform;
        const deviceId = !targets && cursor.platform === 'android' ? null : deviceAt(event.ts);
        const target = targets ? (deviceId ? byId.get(deviceId) : undefined) : retainedTarget();
        const startedAt = event.requestId ? matched.get(event.requestId) : undefined;
        if (target) out.push(agentRecord(event, deviceId || null, target, startedAt));
      }
    }
    return out.toSorted((a, b) => (a.ts as number) - (b.ts as number));
  };
}
