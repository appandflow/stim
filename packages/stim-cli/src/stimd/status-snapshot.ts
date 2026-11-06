import { createHash } from 'node:crypto';
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

const IGNORED_ENV = new Set(['STIM_RUN_ID', 'STIM_TRACE', 'STIM_NO_UPDATE_CHECK', 'STIM_ROUTER_FALLBACK']);

/**
 * A digest of the `STIM_` variables of `env` that can change a status payload. The status entry computes the same one
 * for its caller, and stimd answers only a caller whose digest matches its own.
 */
function stimEnv(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter(([name, value]) => name.startsWith('STIM_') && !IGNORED_ENV.has(name) && value !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

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

  let pending: { thread: Worker; resolve: (json: string) => void; reject: (error: Error) => void } | null = null;
  const start = () => {
    const thread = new Worker(spawnEntry('stimd-status'));
    thread.unref();
    const gone = (error: Error) => {
      if (worker === thread) worker = null;
      if (pending?.thread !== thread) return;
      pending.reject(error);
      pending = null;
    };
    thread.on('message', (message: { json?: string; failed?: string }) => {
      if (pending?.thread !== thread) return;
      const answered = pending;
      pending = null;
      if (typeof message.json === 'string') answered.resolve(message.json);
      else answered.reject(new Error(message.failed ?? 'the status thread answered nothing'));
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
        pending = { thread, resolve, reject };
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
      snapshots.set(cwd, snapshot);
      for (const old of [...snapshots.keys()].filter((key) => !recent.includes(key))) snapshots.delete(old);
    })().finally(() => probes.delete(cwd));
    queue = next.catch(() => {});
    probes.set(cwd, next);
    return next;
  };
  const behind = (cwd: string) =>
    void probe(cwd).catch((error: unknown) =>
      log('warn', 'status_snapshot_failed', `status for ${cwd}: ${error instanceof Error ? error.message : error}`),
    );

  const ownEnv = stimEnv(process.env);
  let recent: string[] = [];
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(saved)) recent = saved.filter((cwd): cwd is string => typeof cwd === 'string').slice(-KEPT);
  } catch {}
  for (const cwd of recent.slice(-READ_AT_BOOT)) behind(cwd);
  const used = (cwd: string) => {
    if (recent.at(-1) === cwd) return;
    recent = [...recent.filter((entry) => entry !== cwd), cwd].slice(-KEPT);
    try {
      writeFileSync(file, JSON.stringify(recent));
    } catch {}
  };

  return {
    async answer(params) {
      const { cwd, fresh, env } = isJsonObject(params) ? params : {};
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) return failed('status names no absolute directory');
      if (env !== ownEnv) return failed("the caller's STIM_ settings differ from stimd's");
      used(cwd);
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
