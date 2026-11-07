import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  deviceHostArea,
  hostedMacosLogsDir,
  isJsonObject,
  readHostedMacosApp,
  readHostedSessions,
  readMacosRecord,
  type MacosAppRecord,
  type MacosProcess,
} from '@stim-cli/core/state';
import { MACOS_APP_STDERR, MACOS_APP_STDOUT } from '../../macos/state.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { readWebRecord } from '../../web/state.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { loadConfig } from '../../workspace/config.ts';
import { observeBrowser } from './web.ts';

const TAIL_MS = 250;
const HOSTED_SCAN_MS = 2000;
const CHUNK_BYTES = 64 * 1024;
const LINE_BYTES = 65536;
const TAIL_MARK = 'macos-app.tail.json';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;

interface Stream {
  token: string;
  attached?: Promise<void>;
  ended: Promise<void>;
  close(): void;
}

/**
 * The streams stimd keeps for what a workspace's op launched through `spawnOwned`: one DevTools observer per owned
 * Chrome and one output tail per macOS app, each found from workspace state or a hosted session and kept while that
 * process runs, so a restarted stimd picks them up again.
 */
export interface OwnedStreams {
  /**
   * Starts the streams a workspace's state names and that no stream follows yet: of `root`, or of every registered
   * workspace and hosted macOS session. For `root` it resolves once the owned Chrome's page is attached, to null, or to
   * why it could not be.
   */
  sync(root?: string): Promise<string | null>;
  running(): boolean;
  close(): void;
}

// compat C27 until removal-minor
/** Whether a live supervisor an older Stim started still owns the process `pid`, and observes it itself. */
function legacy(owner: { pid: number; processToken: string } | undefined, pid: number): boolean {
  return owner !== undefined && owner.pid !== pid && inspectProcessIdentity(owner) === 'same';
}
// compat end

export function createOwnedStreams(log: Log): OwnedStreams {
  const streams = new Map<string, Stream>();
  const ended = new Map<string, string>();
  let closed = false;
  const keep = (key: string, stream: Stream) => {
    streams.set(key, stream);
    void stream.ended.then(() => {
      if (streams.get(key) !== stream) return undefined;
      streams.delete(key);
      if (!closed) ended.set(key, stream.token);
      return undefined;
    });
  };
  const current = (key: string, token: string) => {
    const stream = streams.get(key);
    if (stream?.token === token) return true;
    stream?.close();
    return false;
  };
  const macos = (dir: string | null, record: MacosAppRecord | null) => {
    if (!dir || !record?.app) return;
    const identity = inspectProcessIdentity(record.app);
    if (identity === 'unknown') return;
    // compat C27 until removal-minor
    if (record.supervisor?.pid !== record.app.pid) return;
    // compat end
    if (identity !== 'same' && drained(dir, record.app)) return;
    const key = `macos:${dir}`;
    if (current(key, record.app.processToken) || ended.get(key) === record.app.processToken) return;
    keep(key, tailMacosApp(dir, record.app, record.product));
  };
  const workspace = (root: string, asked: boolean): Promise<void> | null => {
    const record = readMacosRecord(root);
    if (!record?.host) macos(workspaceLogsDir(root), record);
    const web = readWebRecord(root);
    if (!web?.chromeProcess || inspectProcessIdentity(web.chromeProcess) !== 'same') return null;
    // compat C27 until removal-minor
    if (legacy(web, web.chromeProcess.pid)) return null;
    // compat end
    const key = `web:${root}`;
    if (current(key, web.chromeProcess.processToken)) return streams.get(key)?.attached ?? null;
    if (!asked && ended.get(key) === web.chromeProcess.processToken) return null;
    const stream = observeBrowser(root, web, web.chromeProcess);
    keep(key, { token: web.chromeProcess.processToken, ...stream });
    return stream.attached;
  };
  const hosted = () => {
    if (closed) return;
    try {
      for (const session of readHostedSessions()) {
        if (session.platform !== 'macos') continue;
        const home = join(deviceHostArea(session.id), 'home');
        macos(hostedMacosLogsDir(home), readHostedMacosApp(home));
      }
    } catch (error) {
      log('warn', 'owned_hosted_scan_failed', error instanceof Error ? error.message : String(error));
    }
  };
  const timer = setInterval(hosted, HOSTED_SCAN_MS);
  timer.unref();
  return {
    async sync(root) {
      if (closed) return 'stimd is stopping';
      if (root !== undefined) {
        try {
          await workspace(root, true);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
      let paths: string[];
      try {
        paths = Object.keys(loadConfig()?.projects ?? {});
      } catch (error) {
        log('warn', 'owned_sync_failed', error instanceof Error ? error.message : String(error));
        paths = [];
      }
      for (const path of paths) {
        try {
          workspace(path, false)?.catch(() => {});
        } catch (error) {
          log('warn', 'owned_sync_failed', `${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      hosted();
      return null;
    },
    running: () => streams.size > 0,
    close() {
      closed = true;
      clearInterval(timer);
      for (const stream of streams.values()) stream.close();
      streams.clear();
    },
  };
}

function readMark(dir: string): Record<string, unknown> | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dir, TAIL_MARK), 'utf8'));
    return isJsonObject(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Whether a tail already copied all of the exited app's output and wrote its exit. */
function drained(dir: string, app: MacosProcess): boolean {
  const mark = readMark(dir);
  return mark?.processToken === app.processToken && mark.exited === true;
}

function lineSplitter(write: (line: string) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk: Buffer) {
      pending += decoder.write(chunk);
      while (pending.length > LINE_BYTES && !pending.includes('\n')) {
        write(pending.slice(0, LINE_BYTES));
        pending = pending.slice(LINE_BYTES);
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) write(line.replace(/\r$/, ''));
    },
    end() {
      pending += decoder.end();
      if (pending) write(pending);
      pending = '';
    },
  };
}

/**
 * Follows the stdout and stderr files of a macOS app `spawnOwned` started into `macos.ndjson` in `dir`, as client
 * records at info and warn, from the offsets a previous stimd recorded for the same app, and writes the app's exit
 * once it is gone, including for an app that exited before any tail saw it. The exit code is not known: no parent waits on the app.
 */
function tailMacosApp(dir: string, app: MacosProcess, product: string): Stream {
  const writer = createNdjsonWriter(join(dir, 'macos.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const mark = join(dir, TAIL_MARK);
  const offsets = { out: 0, err: 0 };
  const saved = readMark(dir);
  if (saved?.processToken === app.processToken) {
    offsets.out = Number(saved.out) || 0;
    offsets.err = Number(saved.err) || 0;
  }
  const write = (level: string) => (msg: string) => writer.write({ src: 'client', platform: 'macos', level, msg });
  const files = [
    { key: 'out' as const, path: join(dir, MACOS_APP_STDOUT), lines: lineSplitter(write('info')) },
    { key: 'err' as const, path: join(dir, MACOS_APP_STDERR), lines: lineSplitter(write('warn')) },
  ];
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const read = () => {
    let moved = false;
    for (const file of files) {
      let fd: number;
      try {
        if (statSync(file.path).size < offsets[file.key]) continue;
        fd = openSync(file.path, 'r');
      } catch {
        continue;
      }
      try {
        for (let n = readSync(fd, buffer, 0, CHUNK_BYTES, offsets[file.key]); n > 0;) {
          file.lines.push(buffer.subarray(0, n));
          offsets[file.key] += n;
          moved = true;
          n = readSync(fd, buffer, 0, CHUNK_BYTES, offsets[file.key]);
        }
      } finally {
        closeSync(fd);
      }
    }
    if (moved) {
      try {
        writeFileSync(mark, JSON.stringify({ processToken: app.processToken, ...offsets }));
      } catch {}
    }
  };
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let done = false;
  const stop = () => {
    done = true;
    clearInterval(timer);
    writer.close();
    end();
  };
  const timer = setInterval(() => {
    const identity = inspectProcessIdentity(app);
    read();
    if (identity !== 'gone' && identity !== 'different') return;
    for (const file of files) file.lines.end();
    writer.write({ src: 'client', platform: 'macos', level: 'info', msg: `Exited ${product}.` });
    try {
      writeFileSync(mark, JSON.stringify({ processToken: app.processToken, ...offsets, exited: true }));
    } catch {}
    stop();
  }, TAIL_MS);
  timer.unref();
  return {
    token: app.processToken,
    ended,
    close() {
      if (!done) stop();
    },
  };
}
