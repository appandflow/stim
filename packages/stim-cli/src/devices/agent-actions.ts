import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NdjsonRecord, ProjectRecord } from '@stim-cli/core/state';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { projectDeviceSlots } from './device-slots.ts';
import { agentDeviceLiveness, readAgentDeviceRecords } from './activity.ts';

export interface AgentTarget {
  platform: 'ios' | 'android';
  id: string;
  slot: string;
  name?: string;
}

interface AgentEvent {
  ts: number;
  session: string;
  kind: 'action.recorded' | 'request.finished';
  command: string;
  summary: string;
  failed: boolean;
  details: Record<string, unknown> | null;
}

interface ParsedAgentEvents {
  events: AgentEvent[];
  session: string | null;
  unknownVersion: { version: unknown; ts: number | null } | null;
}

const EVENTS_VERSION = 1;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAgentEvents(lines: readonly string[]): ParsedAgentEvents {
  const events: AgentEvent[] = [];
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
    if (kind !== 'action.recorded' && kind !== 'request.finished') continue;
    const failed = kind === 'request.finished' && entry.status === 'error';
    if (kind === 'request.finished' && !failed) continue;
    if (!Number.isFinite(ts) || typeof entry.session !== 'string' || typeof command !== 'string') continue;
    if (typeof summary !== 'string') continue;
    events.push({ ts, session: entry.session, kind, command, summary, failed, details: object(entry.details) });
  }
  return { events, session, unknownVersion };
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

function agentRecord(event: AgentEvent, deviceId: string, target: AgentTarget): NdjsonRecord {
  return {
    ts: event.ts,
    src: 'agent',
    level: event.failed ? 'error' : 'info',
    msg: event.summary,
    event: event.failed ? 'agent_failed' : 'agent_action',
    command: event.command,
    session: event.session,
    platform: target.platform,
    deviceId,
    ...(target.slot === 'default' ? {} : { slot: target.slot }),
    ...(event.details ? { details: event.details } : {}),
  };
}

function formatUnknownRecord(
  session: string,
  unknown: NonNullable<ParsedAgentEvents['unknownVersion']>,
  target: AgentTarget,
  now: number,
): NdjsonRecord {
  return {
    ts: unknown.ts ?? now,
    src: 'agent',
    level: 'warn',
    msg: `agent-device session ${session} records events in an unrecognized format (version ${JSON.stringify(unknown.version) ?? 'missing'}); its actions are not shown.`,
    event: 'agent_format_unknown',
    session,
    platform: target.platform,
    ...(target.slot === 'default' ? {} : { slot: target.slot }),
  };
}

export function workspaceAgentTargets(project: ProjectRecord | null | undefined): AgentTarget[] {
  const targets: AgentTarget[] = [];
  let slots: ReturnType<typeof projectDeviceSlots>;
  try {
    slots = projectDeviceSlots(project);
  } catch {
    return [];
  }
  for (const { slot, platforms } of slots) {
    const { ios, android } = platforms;
    if (ios?.owned && typeof ios.deviceUdid === 'string') targets.push({ platform: 'ios', id: ios.deviceUdid, slot });
    if (android?.owned && typeof android.consolePort === 'number' && typeof android.avdName === 'string')
      targets.push({ platform: 'android', id: `emulator-${android.consolePort}`, slot, name: android.avdName });
  }
  return targets;
}

function envDir(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : null;
}

function readCompleteLines(path: string, start: number): { text: string; next: number; size: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= start) return { text: '', next: start, size };
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    return { text: end < 0 ? '' : buffer.toString('utf8', 0, end + 1), next: start + end + 1, size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface SessionCursor {
  offset: number;
  closes: number[];
  runner: { size: number; spans: RunnerSpan[] } | null;
  session: string | null;
  unknownReported: boolean;
}

export interface AgentActionReaderOptions {
  targets: AgentTarget[];
  sinceTs?: number;
  home?: string;
  now?: () => number;
  startOf?: (pid: number) => ProcessStart;
}

/**
 * Returns a reader of agent-device actions on the given devices. Each call returns the records written
 * since the previous call; the first call returns the retained history newer than `sinceTs`. It only reads
 * agent-device's state directory, and any file it cannot read or recognize yields no records.
 */
export function createAgentActionReader({
  targets,
  sinceTs = -Infinity,
  home = homedir(),
  now = Date.now,
  startOf = inspectProcessStart,
}: AgentActionReaderOptions): () => NdjsonRecord[] {
  const sessionsDir = join(envDir('AGENT_DEVICE_STATE_DIR') ?? join(home, '.agent-device'), 'sessions');
  const cursors = new Map<string, SessionCursor>();
  const byId = new Map(targets.map((target) => [target.id, target]));

  return () => {
    if (!targets.length) return [];
    let names: string[];
    try {
      names = readdirSync(sessionsDir);
    } catch {
      return [];
    }
    let claimed: Map<string, string> | undefined;
    const claimedDevice = (session: string) =>
      (claimed ??= new Map(
        readAgentDeviceRecords(home)
          .filter((record) => record.kind === 'claim' && record.session && record.deviceId)
          .filter((record) => {
            const target = byId.get(record.deviceId!);
            return target?.name === undefined || target.name === record.deviceName;
          })
          .filter((record) => agentDeviceLiveness(record, startOf) === 'live')
          .map((record) => [record.session!, record.deviceId!]),
      )).get(session) ?? null;

    const out: NdjsonRecord[] = [];
    for (const name of names) {
      const dir = join(sessionsDir, name);
      const eventsPath = join(dir, 'events.ndjson');
      const lines: string[] = [];
      let cursor = cursors.get(name);
      if (!cursor) {
        try {
          if (statSync(eventsPath).mtimeMs < sinceTs) continue;
        } catch {
          continue;
        }
        cursor = { offset: 0, closes: [], runner: null, session: null, unknownReported: false };
        cursors.set(name, cursor);
        try {
          lines.push(...readFileSync(`${eventsPath}.1`, 'utf8').split('\n'));
        } catch {}
      }
      // agent-device rotates events.ndjson to events.ndjson.1 at AGENT_DEVICE_EVENT_LOG_MAX_BYTES (5 MiB by
      // default). A rotation between two reads restarts at the new file; the unread tail of .1 is skipped.
      let chunk = readCompleteLines(eventsPath, cursor.offset);
      if (chunk && chunk.size < cursor.offset) chunk = readCompleteLines(eventsPath, 0);
      if (!chunk) continue;
      cursor.offset = chunk.next;
      lines.push(...chunk.text.split('\n'));
      const parsed = parseAgentEvents(lines);
      cursor.session ??= parsed.session;
      const session = cursor.session;
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
      for (const event of parsed.events) if (event.command === 'close' && !event.failed) cursor.closes.push(event.ts);
      // agent-device starts an iOS runner lazily, on the first command that needs it, so the runner log dates a
      // device change late. A session that closes and reopens on another simulator changes device at the close.
      const spans = sessionSpans(cursor.runner.spans, cursor.closes);
      const deviceAt = (ts: number) => (spans.length ? spanDevice(spans, ts) : session && claimedDevice(session));

      if (parsed.unknownVersion && !cursor.unknownReported) {
        const deviceId = spans.at(-1)?.deviceId ?? (session && claimedDevice(session));
        const target = deviceId ? byId.get(deviceId) : undefined;
        if (target) {
          cursor.unknownReported = true;
          out.push(formatUnknownRecord(session ?? name, parsed.unknownVersion, target, now()));
        }
      }
      for (const event of parsed.events) {
        if (event.ts < sinceTs) continue;
        const deviceId = deviceAt(event.ts);
        const target = deviceId ? byId.get(deviceId) : undefined;
        if (target && deviceId) out.push(agentRecord(event, deviceId, target));
      }
    }
    return out.toSorted((a, b) => (a.ts as number) - (b.ts as number));
  };
}
