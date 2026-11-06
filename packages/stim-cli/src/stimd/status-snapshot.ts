import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isJsonObject } from '@stim-cli/core/state';
import { spawnEntry } from '../spawn-entry.ts';

const IDLE_MS = 2 * 60_000;
const BOOTING_WAIT_MS = 1000;
const KEPT = 16;
const READ_AT_BOOT = 4;

const failed = (error: unknown): string =>
  JSON.stringify({ op: 'status', error: error instanceof Error ? error.message : String(error) });

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;

export interface StatusSnapshots {
  /**
   * stimd's answer to `status {cwd, fresh}`, one JSON line: `{op: 'status', ageMs, status}` with the `stim status
   * --json` payload, `{op: 'status', ageMs: null, booting: true}` while it has none, or `{op: 'status', error}`.
   */
  answer(params: unknown): Promise<string>;
  close(): void;
}

/**
 * The `stim status --json` payload stimd keeps for each of the last {@link KEPT} directories a status asked from, so
 * that status answers at once. Each answer reads that directory again behind it on the `status` thread, which a probe
 * starts and two idle minutes end; `fresh` waits for that read first. With no snapshot yet, the answer waits up to
 * {@link BOOTING_WAIT_MS} for the first read, then says `booting`. The directories are kept in `file`, and a new stimd
 * reads the last {@link READ_AT_BOOT} again at boot.
 */
export function createStatusSnapshots(log: Log, file: string): StatusSnapshots {
  const snapshots = new Map<string, { json: string; at: number }>();
  const probes = new Map<string, Promise<void>>();
  let worker: Worker | null = null;
  let idle: NodeJS.Timeout | null = null;
  let queue = Promise.resolve();
  let closed = false;

  let pending: { resolve: (json: string) => void; reject: (error: Error) => void } | null = null;
  const start = () => {
    const thread = new Worker(spawnEntry('stimd-status'));
    thread.unref();
    const gone = (error: Error) => {
      if (worker === thread) worker = null;
      pending?.reject(error);
      pending = null;
    };
    thread.on('message', (message: { json?: string; failed?: string }) => {
      const answered = pending;
      pending = null;
      if (typeof message.json === 'string') answered?.resolve(message.json);
      else answered?.reject(new Error(message.failed ?? 'the status thread answered nothing'));
    });
    thread.on('error', (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      log('warn', 'status_thread_failed', failure.message);
      gone(failure);
    });
    thread.on('exit', (code) => gone(new Error(`the status thread exited with code ${code}`)));
    return thread;
  };
  const read = async (cwd: string): Promise<{ json: string; at: number }> => {
    if (idle) clearTimeout(idle);
    const thread = (worker ??= start());
    const at = Date.now();
    try {
      const json = await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        thread.postMessage({ cwd });
      });
      return { json, at };
    } finally {
      idle = setTimeout(() => {
        if (worker === thread) worker = null;
        void thread.terminate();
      }, IDLE_MS).unref();
    }
  };

  const probe = (cwd: string): Promise<void> => {
    const running = probes.get(cwd);
    if (running) return running;
    const next = (async () => {
      await queue;
      if (closed) throw new Error('stimd is stopping');
      const snapshot = await read(cwd);
      const known = snapshots.has(cwd);
      snapshots.delete(cwd);
      snapshots.set(cwd, snapshot);
      for (const old of [...snapshots.keys()].slice(0, -KEPT)) snapshots.delete(old);
      if (!known) writeFileSync(file, JSON.stringify([...snapshots.keys()]));
    })().finally(() => probes.delete(cwd));
    queue = next.catch(() => {});
    probes.set(cwd, next);
    return next;
  };
  const behind = (cwd: string) =>
    void probe(cwd).catch((error: unknown) =>
      log('warn', 'status_snapshot_failed', `status for ${cwd}: ${error instanceof Error ? error.message : error}`),
    );

  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(saved)) for (const cwd of saved.slice(-READ_AT_BOOT)) if (typeof cwd === 'string') behind(cwd);
  } catch {}

  return {
    async answer(params) {
      const { cwd, fresh } = isJsonObject(params) ? params : {};
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) return failed('status names no absolute directory');
      if (fresh === true) {
        try {
          await probe(cwd);
        } catch (error) {
          return failed(error);
        }
      } else if (!snapshots.has(cwd)) {
        await Promise.race([probe(cwd).catch(() => {}), new Promise((done) => setTimeout(done, BOOTING_WAIT_MS))]);
      } else behind(cwd);
      const snapshot = snapshots.get(cwd);
      if (!snapshot)
        return probes.has(cwd)
          ? JSON.stringify({ op: 'status', ageMs: null, booting: true })
          : failed('the status thread answered nothing');
      return `{"op":"status","ageMs":${Date.now() - snapshot.at},"status":${snapshot.json}}`;
    },
    close() {
      closed = true;
      if (idle) clearTimeout(idle);
      void worker?.terminate();
      worker = null;
    },
  };
}
