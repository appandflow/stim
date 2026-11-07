import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawnEntry } from '../../spawn-entry.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';

export interface LogSink {
  writer: NdjsonWriter;
  line(line: string, clockOffsetMs: number | null): void;
  beforeFinish(signalled: boolean): void;
  addAlias(slotKey: string, attribution: Record<string, unknown>): Promise<void>;
  removeAlias(slotKey: string): Promise<void>;
  closed(): Promise<void>;
}

export interface LogWriters {
  open(
    input: {
      streamId: string;
      root: string;
      platform: 'ios' | 'android';
      physical: boolean;
      bundleId?: string;
      slotKey: string;
      attribution: Record<string, unknown>;
    },
    onFlow: (paused: boolean) => void,
  ): Promise<LogSink>;
  close(): Promise<void>;
}

export function createLogWriters(
  onFailure: (error: Error) => void,
  onChange: (streamId: string) => void = () => {},
): LogWriters {
  const worker = new Worker(spawnEntry('stimd-thread'), { workerData: { stimdThread: 'logs' } });
  let next = 0;
  let failed: Error | null = null;
  let closing = false;
  const flow = new Map<string, { bytes: number; paused: boolean; change: (paused: boolean) => void }>();
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    onFailure(error);
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!closing) fail(new Error(`the logs worker exited with code ${code}`));
  });
  worker.on(
    'message',
    (message: {
      requestId?: number;
      error?: string;
      event?: string;
      message?: string;
      streamId?: string;
      bytes?: number;
    }) => {
      if (message.event === 'changed' && message.streamId) {
        onChange(message.streamId);
        return;
      }
      if (message.event === 'drained' && message.streamId) {
        const state = flow.get(message.streamId);
        if (state) {
          state.bytes = Math.max(0, state.bytes - (message.bytes ?? 0));
          if (state.paused && state.bytes < 512 * 1024) {
            state.paused = false;
            state.change(false);
          }
        }
        return;
      }
      if (message.event === 'error') return fail(new Error(message.message ?? 'the logs worker failed'));
      if (message.requestId === undefined) return;
      const request = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve();
    },
  );
  const send = (message: Record<string, unknown>): void => {
    if (failed) throw failed;
    worker.postMessage(message);
  };
  const request = (message: Record<string, unknown>): Promise<void> => {
    if (failed) return Promise.reject(failed);
    const requestId = ++next;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        send({ ...message, requestId });
      } catch (error) {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  return {
    async open(input, onFlow) {
      await request({ op: 'open', ...input });
      const state = { bytes: 0, paused: false, change: onFlow };
      flow.set(input.streamId, state);
      const file = join(workspaceLogsDir(input.root), 'device.ndjson');
      let closed = Promise.resolve();
      const writer: NdjsonWriter = {
        file,
        written: 0,
        dropped: 0,
        lastError: null,
        write(record) {
          try {
            send({ op: 'record', streamId: input.streamId, record });
            return true;
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return false;
          }
        },
        close() {
          closed = request({ op: 'close', streamId: input.streamId }).finally(() => flow.delete(input.streamId));
          void closed.catch(() => {});
          return { file, written: 0, dropped: 0, lastError: null };
        },
      };
      return {
        writer,
        line: (line, clockOffsetMs) => {
          try {
            const bytes = Buffer.byteLength(line);
            send({ op: 'line', streamId: input.streamId, line, clockOffsetMs, bytes });
            state.bytes += bytes;
            if (!state.paused && state.bytes >= 1024 * 1024) {
              state.paused = true;
              state.change(true);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        beforeFinish: (signalled) => {
          try {
            send({ op: 'before-finish', streamId: input.streamId, signalled });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        addAlias: (slotKey, attribution) =>
          request({ op: 'add-alias', streamId: input.streamId, slotKey, attribution }),
        removeAlias: (slotKey) => request({ op: 'remove-alias', streamId: input.streamId, slotKey }),
        closed: () => closed,
      };
    },
    async close() {
      closing = true;
      await worker.terminate();
    },
  };
}
