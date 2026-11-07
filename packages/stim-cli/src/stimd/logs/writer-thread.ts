import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { createNdjsonWriter, type NdjsonWriter } from '../../ndjson.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { parseLogcatLine } from './android.ts';
import { parseDeviceConsoleLine } from './ios-device.ts';
import { parseLogStreamLine } from './ios.ts';

if (!parentPort) throw new Error('the logs worker requires a parent port');
const port = parentPort;
type Entry = {
  writer: NdjsonWriter;
  platform: 'ios' | 'android';
  physical: boolean;
  bundleId?: string;
  attributions: Map<string, Record<string, unknown>>;
  captured: number;
};
const streams = new Map<string, Entry>();

type Message =
  | {
      op: 'open';
      requestId: number;
      streamId: string;
      root: string;
      platform: 'ios' | 'android';
      physical: boolean;
      bundleId?: string;
      slotKey: string;
      attribution: Record<string, unknown>;
    }
  | { op: 'add-alias'; requestId: number; streamId: string; slotKey: string; attribution: Record<string, unknown> }
  | { op: 'remove-alias'; requestId: number; streamId: string; slotKey: string }
  | { op: 'record'; streamId: string; record: unknown }
  | { op: 'line'; streamId: string; line: string; clockOffsetMs: number | null; bytes: number }
  | { op: 'before-finish'; streamId: string; signalled: boolean }
  | { op: 'close'; requestId: number; streamId: string };

port.on('message', (message: Message) => {
  try {
    if (message.op === 'open') {
      const writer = createNdjsonWriter(join(workspaceLogsDir(message.root), 'device.ndjson'), {
        maxBytes: LOG_ROTATE_BYTES,
        fields: { streamId: message.streamId },
      });
      streams.set(message.streamId, {
        writer,
        platform: message.platform,
        physical: message.physical,
        bundleId: message.bundleId,
        attributions: new Map([[message.slotKey, message.attribution]]),
        captured: 0,
      });
      port.postMessage({ requestId: message.requestId });
      return;
    }
    const stream = streams.get(message.streamId);
    if (!stream) throw new Error('the device log stream is not open');
    const write = (value: unknown): boolean => {
      if (!isJsonObject(value)) return stream.writer.write(value);
      const { slot: _slot, deviceId: _deviceId, ...base } = value;
      let wrote = false;
      for (const attribution of stream.attributions.values())
        wrote = stream.writer.write({ ...base, ...attribution }) || wrote;
      return wrote;
    };
    if (message.op === 'add-alias') {
      stream.attributions.set(message.slotKey, message.attribution);
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'remove-alias') {
      stream.attributions.delete(message.slotKey);
      port.postMessage({ requestId: message.requestId });
    } else if (message.op === 'record') {
      if (write(message.record)) port.postMessage({ event: 'changed', streamId: message.streamId });
    } else if (message.op === 'line') {
      const parse =
        stream.platform === 'ios' ? (stream.physical ? parseDeviceConsoleLine : parseLogStreamLine) : parseLogcatLine;
      const record = parse(message.line, { now: Date.now, clockOffsetMs: message.clockOffsetMs });
      if (record) {
        stream.captured++;
        if (write({ ...record, platform: stream.platform }))
          port.postMessage({ event: 'changed', streamId: message.streamId });
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
    if (message.op === 'line') port.postMessage({ event: 'drained', streamId: message.streamId, bytes: message.bytes });
  }
});
