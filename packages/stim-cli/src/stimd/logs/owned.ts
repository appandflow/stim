import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
import { macosAppLogName } from '../../macos/state.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { processGroupAlive } from '../../ownership-claim.ts';
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
  drain?(): boolean;
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
  drain(root: string): Promise<string | null>;
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
    if (stream?.drain && !stream.drain()) throw new Error('the previous macOS app output could not be drained');
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
    keep(key, tailMacosApp(dir, record.app, record.product, record.launchId));
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
    async drain(root) {
      if (closed) return 'stimd is stopping';
      try {
        workspace(root, false)?.catch(() => {});
        for (const key of [`macos:${workspaceLogsDir(root)}`, `web:${root}`]) {
          const stream = streams.get(key);
          if (!stream) continue;
          if (stream.attached) await stream.attached.catch(() => {});
          if (stream.drain && !stream.drain())
            return 'the macOS app output could not be drained or its process group could not be verified stopped';
          ended.set(key, stream.token);
          streams.delete(key);
          stream.close();
          await stream.ended;
        }
        const app = readMacosRecord(root);
        if (app?.app && !app.host && app.supervisor?.pid === app.app.pid && !drained(workspaceLogsDir(root), app.app))
          return 'the macOS app output could not be drained';
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
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

function lineSplitter(write: (line: string) => boolean, saved: unknown) {
  let pending = typeof saved === 'string' ? Buffer.from(saved, 'base64') : Buffer.alloc(0);
  const flush = (): boolean => {
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline >= 0) {
        if (!write(pending.subarray(0, newline).toString('utf8').replace(/\r$/, ''))) return false;
        pending = pending.subarray(newline + 1);
      } else if (pending.length > LINE_BYTES) {
        let end = LINE_BYTES;
        while (end > 0 && (pending.readUInt8(end) & 0xc0) === 0x80) end--;
        if (!write(pending.subarray(0, end).toString('utf8'))) return false;
        pending = pending.subarray(end);
      } else return true;
    }
  };
  return {
    push(chunk: Buffer): boolean {
      pending = Buffer.concat([pending, chunk]);
      return flush();
    },
    flush,
    save: () => pending.toString('base64'),
    end(): boolean {
      if (!flush()) return false;
      if (pending.length && !write(pending.toString('utf8'))) return false;
      pending = Buffer.alloc(0);
      return true;
    },
  };
}

/**
 * Follows the stdout and stderr files of a macOS app `spawnOwned` started into `macos.ndjson` in `dir`, as client
 * records at info and warn, from the offsets a previous stimd recorded for the same app, and writes the app's exit
 * once it is gone, including for an app that exited before any tail saw it. The exit code is not known: no parent waits on the app.
 */
function tailMacosApp(dir: string, app: MacosProcess, product: string, launchId: string): Stream {
  const writer = createNdjsonWriter(join(dir, 'macos.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const mark = join(dir, TAIL_MARK);
  const offsets = { out: 0, err: 0 };
  const saved = readMark(dir);
  if (saved?.processToken === app.processToken) {
    offsets.out = Number(saved.out) || 0;
    offsets.err = Number(saved.err) || 0;
  }
  const write = (level: string) => (msg: string) => writer.write({ src: 'client', platform: 'macos', level, msg });
  const matching = saved?.processToken === app.processToken;
  let recovering: 'out' | 'err' | null =
    matching && (saved.resetting === 'out' || saved.resetting === 'err') ? saved.resetting : null;
  if (recovering) offsets[recovering] = 0;
  const files = [
    {
      key: 'out' as const,
      path: join(dir, macosAppLogName(launchId, 'out')),
      lines: lineSplitter(write('info'), matching && recovering !== 'out' ? saved.outPending : null),
    },
    {
      key: 'err' as const,
      path: join(dir, macosAppLogName(launchId, 'err')),
      lines: lineSplitter(write('warn'), matching && recovering !== 'err' ? saved.errPending : null),
    },
  ] as const;
  const checkpoint = (resetting?: 'out' | 'err', exited = false) => {
    const staging = `${mark}.tmp`;
    writeFileSync(
      staging,
      JSON.stringify({
        processToken: app.processToken,
        ...offsets,
        outPending: files[0].lines.save(),
        errPending: files[1].lines.save(),
        ...(resetting ? { resetting } : {}),
        ...(exited ? { exited: true } : {}),
      }),
    );
    renameSync(staging, mark);
  };
  let recoveryWarningPending = recovering !== null;
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const read = (): boolean => {
    if (recoveryWarningPending) {
      if (!write('warn')('macOS app output may have been dropped when its raw log reached the size limit.'))
        return false;
      recoveryWarningPending = false;
    }
    let moved = false;
    let complete = true;
    for (const file of files) {
      const before = file.lines.save();
      const flushed = file.lines.flush();
      if (before !== file.lines.save()) moved = true;
      if (!flushed) {
        complete = false;
        continue;
      }
      let fd: number;
      let size: number;
      try {
        size = statSync(file.path).size;
        if (size < offsets[file.key]) {
          complete = false;
          continue;
        }
        fd = openSync(file.path, 'r');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) complete = false;
        continue;
      }
      try {
        const limit = Math.min(size, offsets[file.key] + LOG_ROTATE_BYTES);
        while (offsets[file.key] < limit) {
          const n = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, limit - offsets[file.key]), offsets[file.key]);
          if (n === 0) break;
          const written = file.lines.push(buffer.subarray(0, n));
          offsets[file.key] += n;
          moved = true;
          if (!written) {
            complete = false;
            break;
          }
        }
      } catch {
        complete = false;
      } finally {
        closeSync(fd);
      }
      if (complete && size >= LOG_ROTATE_BYTES) {
        try {
          if (!file.lines.end()) {
            complete = false;
            continue;
          }
          checkpoint(file.key);
          if (!write('warn')('macOS app output may have been dropped when its raw log reached the size limit.')) {
            complete = false;
            continue;
          }
          truncateSync(file.path);
          offsets[file.key] = 0;
          checkpoint();
        } catch {
          complete = false;
        }
      }
    }
    if (moved || recovering) {
      try {
        checkpoint();
        recovering = null;
      } catch {
        complete = false;
      }
    }
    return complete;
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
  let exitWritten = false;
  const finish = () => {
    if (!read()) return false;
    const identity = inspectProcessIdentity(app);
    if ((identity !== 'gone' && identity !== 'different') || processGroupAlive(app.pid)) return false;
    for (const file of files) if (!file.lines.end()) return false;
    if (!exitWritten) {
      if (!writer.write({ src: 'client', platform: 'macos', level: 'info', msg: `Exited ${product}.` })) return false;
      exitWritten = true;
    }
    try {
      checkpoint(undefined, true);
    } catch {
      return false;
    }
    stop();
    try {
      for (const file of files) rmSync(file.path, { force: true });
    } catch {}
    return true;
  };
  const timer = setInterval(finish, TAIL_MS);
  timer.unref();
  return {
    token: app.processToken,
    ended,
    drain: finish,
    close() {
      if (!done && !finish()) stop();
    },
  };
}
