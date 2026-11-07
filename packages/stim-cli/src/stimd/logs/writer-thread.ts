import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { createNdjsonWriter, type NdjsonWriter } from '../../ndjson.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { parseLogcatLine } from './android.ts';
import { parseDeviceConsoleLine } from './ios-device.ts';
import { parseLogStreamLine } from './ios.ts';
import { createOwnedStreams } from './owned.ts';

if (!parentPort) throw new Error('the logs worker requires a parent port');
const port = parentPort;
type Entry = {
  writer: NdjsonWriter;
  platform: 'ios' | 'android';
  physical: boolean;
  bundleId?: string;
  attributions: Map<string, Record<string, unknown>>;
  captured: number;
  observedGeneration: number | null;
  recent: Map<string, number>;
  recentEvictedAt: number;
  pendingHistory: Map<string, number>;
  backfill: { since: number; live: Map<string, number>; warned: boolean; failed: boolean } | null;
};
const streams = new Map<string, Entry>();
const owned = createOwnedStreams(
  (level, event, msg) => port.postMessage({ event: 'owned-log', level, name: event, message: msg }),
  (running) => port.postMessage({ event: 'owned-running', running }),
);

function nativeTimestamp(stream: Entry, line: string): unknown {
  // https://github.com/appandflow/stim/issues/5387: different native timestamp spellings may preserve duplicate evidence.
  if (stream.platform === 'ios' && !stream.physical) return (JSON.parse(line) as { timestamp?: unknown }).timestamp;
  return /^\s*(\d+\.\d{3,6})\s/.exec(line)?.[1];
}

type Message =
  | { op: 'owned-sync'; requestId: number; root?: string }
  | { op: 'owned-drain'; requestId: number; root: string; macosOnly?: boolean }
  | { op: 'owned-drain-hosted'; requestId: number; session: string }
  | { op: 'owned-close'; requestId: number }
  | {
      op: 'open';
      requestId: number;
      streamId: string;
      root: string;
      platform: 'ios' | 'android';
      physical: boolean;
      bundleId?: string;
      runId?: string;
      slotKey: string;
      attribution: Record<string, unknown>;
    }
  | { op: 'add-alias'; requestId: number; streamId: string; slotKey: string; attribution: Record<string, unknown> }
  | { op: 'remove-alias'; requestId: number; streamId: string; slotKey: string }
  | { op: 'record'; streamId: string; record: unknown }
  | {
      op: 'line' | 'backfill.line';
      streamId: string;
      line: string;
      clockOffsetMs: number | null;
      bytes: number;
      generation?: number;
    }
  | { op: 'backfill.begin'; requestId: number; streamId: string; since: number }
  | { op: 'backfill.end'; requestId: number; streamId: string }
  | { op: 'sync'; requestId: number; streamId: string }
  | { op: 'before-finish'; streamId: string; signalled: boolean }
  | { op: 'close'; requestId: number; streamId: string };

const limit = 16_384;
const take = (map: Map<string, number>, key: string): boolean => {
  const count = map.get(key);
  if (!count) return false;
  if (count === 1) map.delete(key);
  else map.set(key, count - 1);
  return true;
};
const add = (map: Map<string, number>, key: string): boolean => {
  if (!map.has(key) && map.size >= limit) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
    map.set(key, 1);
    return false;
  }
  map.set(key, (map.get(key) ?? 0) + 1);
  return true;
};

type OwnedRequest = Extract<Message, { op: 'owned-sync' | 'owned-drain' | 'owned-drain-hosted' }>;

function isOwnedRequest(message: Message): message is OwnedRequest {
  return message.op === 'owned-sync' || message.op === 'owned-drain' || message.op === 'owned-drain-hosted';
}

function handleOwnedRequest(message: OwnedRequest): void {
  const result =
    message.op === 'owned-sync'
      ? owned.sync(message.root)
      : message.op === 'owned-drain'
        ? owned.drain(message.root, message.macosOnly)
        : owned.drainHosted(message.session);
  void result.then(
    (error) => {
      port.postMessage({ event: 'owned-running', running: owned.running() });
      port.postMessage({ requestId: message.requestId, error });
      return undefined;
    },
    (error: unknown) => port.postMessage({ requestId: message.requestId, error: String(error) }),
  );
}

// oxlint-disable-next-line complexity -- The worker dispatches the existing message protocol in one handler.
port.on('message', (message: Message) => {
  try {
    if (isOwnedRequest(message)) {
      handleOwnedRequest(message);
      return;
    }
    if (message.op === 'owned-close') {
      owned.close();
      port.postMessage({ requestId: message.requestId });
      return;
    }
    if (message.op === 'open') {
      const writer = createNdjsonWriter(join(workspaceLogsDir(message.root), 'device.ndjson'), {
        maxBytes: LOG_ROTATE_BYTES,
        fields: { streamId: message.streamId, ...(message.runId ? { runId: message.runId } : {}) },
      });
      streams.set(message.streamId, {
        writer,
        platform: message.platform,
        physical: message.physical,
        bundleId: message.bundleId,
        attributions: new Map([[message.slotKey, message.attribution]]),
        captured: 0,
        observedGeneration: null,
        recent: new Map(),
        recentEvictedAt: 0,
        pendingHistory: new Map(),
        backfill: null,
      });
      port.postMessage({ requestId: message.requestId });
      return;
    }
    const stream = streams.get(message.streamId);
    if (!stream && (message.op === 'line' || message.op === 'backfill.line' || message.op === 'record')) return;
    if (!stream) throw new Error('the device log stream is not open');
    let complete = true;
    const write = (value: unknown): boolean => {
      if (!isJsonObject(value)) return stream.writer.write(value);
      const { slot: _slot, deviceId: _deviceId, ...base } = value;
      let wrote = false;
      for (const attribution of stream.attributions.values()) {
        const persisted = stream.writer.write({ ...base, ...attribution });
        complete &&= persisted;
        wrote ||= persisted;
      }
      return wrote;
    };
    const warnLimited = () => {
      if (!stream.backfill || stream.backfill.warned) return;
      stream.backfill.warned = true;
      if (
        write({
          src: 'device',
          platform: stream.platform,
          level: 'warn',
          event: 'collector_backfill_dedup_limited',
          msg: 'The device log overlap exceeded the 16384-entry deduplication window; duplicate records may appear.',
        })
      )
        port.postMessage({ event: 'changed', streamId: message.streamId });
    };
    if (message.op === 'add-alias') {
      stream.recent.clear();
      stream.pendingHistory.clear();
      stream.backfill?.live.clear();
      stream.attributions.set(message.slotKey, message.attribution);
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'remove-alias') {
      stream.recent.clear();
      stream.pendingHistory.clear();
      stream.backfill?.live.clear();
      stream.attributions.delete(message.slotKey);
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'record') {
      if (write(message.record)) port.postMessage({ event: 'changed', streamId: message.streamId });
    } else if (message.op === 'sync') {
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'backfill.begin') {
      if (stream.backfill) throw new Error('a device log backfill is already running');
      stream.backfill = { since: message.since, live: new Map(stream.recent), warned: false, failed: false };
      if (stream.recentEvictedAt >= message.since) warnLimited();
      for (const [key, count] of stream.pendingHistory) {
        if (!add(stream.backfill.live, key)) warnLimited();
        stream.backfill.live.set(key, stream.backfill.live.get(key)! + count - 1);
      }
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'backfill.end') {
      const failed = stream.backfill?.failed;
      stream.backfill = null;
      port.postMessage({
        requestId: message.requestId,
        ...(failed ? { error: 'device log backfill could not persist its records' } : {}),
      });
    } else if (message.op === 'line' || message.op === 'backfill.line') {
      const parse =
        stream.platform === 'ios' ? (stream.physical ? parseDeviceConsoleLine : parseLogStreamLine) : parseLogcatLine;
      const record = parse(message.line, { now: Date.now, clockOffsetMs: message.clockOffsetMs });
      if (record) {
        if (message.op === 'backfill.line' && stream.backfill && (record.ts ?? 0) < stream.backfill.since) return;
        const nativeTime = nativeTimestamp(stream, message.line);
        const key = JSON.stringify([
          typeof nativeTime === 'string' ? nativeTime : (record.deviceTs ?? record.ts),
          record.ts,
          record.proc,
          record.level,
          record.subsystem,
          record.category,
          createHash('sha256')
            .update(record.msg ?? '')
            .digest('hex'),
        ]);
        const history = message.op === 'backfill.line';
        const duplicate = history
          ? stream.backfill
            ? take(stream.backfill.live, key)
            : false
          : take(stream.pendingHistory, key);
        if (duplicate && !history && !add(stream.recent, key)) {
          stream.recentEvictedAt = Math.max(stream.recentEvictedAt, record.ts ?? Date.now());
          if (stream.backfill) warnLimited();
        }
        let persisted = duplicate;
        if (!duplicate) {
          stream.captured++;
          if (write({ ...record, platform: stream.platform }))
            port.postMessage({ event: 'changed', streamId: message.streamId });
          persisted = complete;
          if (!complete) {
            if (history && stream.backfill) stream.backfill.failed = true;
            if (!history && message.generation !== undefined) {
              stream.observedGeneration = null;
              port.postMessage({ event: 'write-failed', streamId: message.streamId, generation: message.generation });
            }
          }
          if (history && stream.backfill && complete) {
            if (!add(stream.pendingHistory, key)) warnLimited();
          } else if (!history && complete) {
            if (!add(stream.recent, key)) {
              stream.recentEvictedAt = Math.max(stream.recentEvictedAt, record.ts ?? Date.now());
              if (stream.backfill) warnLimited();
            }
            if (stream.backfill && !add(stream.backfill.live, key)) warnLimited();
          }
        }
        if (
          persisted &&
          message.op === 'line' &&
          message.generation !== undefined &&
          message.generation !== stream.observedGeneration
        ) {
          stream.observedGeneration = message.generation;
          port.postMessage({ event: 'observed', streamId: message.streamId, generation: message.generation });
        }
      }
    } else if (message.op === 'before-finish' && stream.physical && stream.captured === 0 && !message.signalled) {
      const written = write({
        src: 'device',
        platform: stream.platform,
        level: 'warn',
        event: 'collector_empty',
        msg: `the device console produced no output for ${stream.bundleId}; devicectl only connects the app's streams when it starts the app, and os_log below the info level never reaches them`,
      });
      if (written) port.postMessage({ event: 'changed', streamId: message.streamId });
    } else if (message.op === 'close') {
      const result = stream.writer.close();
      streams.delete(message.streamId);
      if (result.dropped > 0)
        throw new Error(
          `device log dropped ${result.dropped} record(s): ${result.lastError?.message ?? 'unknown error'}`,
        );
      port.postMessage({ requestId: message.requestId });
    }
  } catch (error) {
    if ('requestId' in message)
      port.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
    else
      port.postMessage({
        event: 'error',
        streamId: message.streamId,
        message: error instanceof Error ? error.message : String(error),
      });
  } finally {
    if (message.op === 'line' || message.op === 'backfill.line')
      port.postMessage({ event: 'drained', streamId: message.streamId, bytes: message.bytes });
  }
});
