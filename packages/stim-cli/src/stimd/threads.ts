import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import type { MaintenanceLane } from '../daemon/passes.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { childKey } from './cleanup-watch.ts';
import { serveThreadJobs } from './thread-jobs.ts';

type ThreadName = 'passes' | 'measure';
type PassesInput = Omit<Parameters<MaintenanceLane['start']>[0], 'operation'> & { act: boolean; cwd: string };
type ThreadInput = PassesInput | { cwd: string };
type Log = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

const IDLE_MS = 2 * 60_000;

type FromThread =
  | {
      type: 'log';
      level: Parameters<Log>[0];
      event: string;
      msg: string;
      fields: Record<string, unknown>;
    }
  | { type: 'done'; result: DaemonLadderAction[] }
  | {
      type: 'failed';
      message: string;
      code?: string;
      remedy?: string;
      reportCleanup?: boolean;
      contained?: { pid: number; processToken: string | null };
    }
  | { type: 'settled'; pending: string[] };

interface Thread {
  worker: Worker;
  pending: {
    resolve: (result: DaemonLadderAction[]) => void;
    reject: (error: Error) => void;
  } | null;
  idle: NodeJS.Timeout | null;
  /** The children whose cleanup a job on this thread could not verify, which the thread itself watches. */
  unsettled: Set<string>;
  lost: boolean;
}

export interface ThreadTable {
  /** Runs one job on the named thread, starting the thread first when it is not running. One job per thread at a time. */
  run(name: ThreadName, input: ThreadInput): Promise<DaemonLadderAction[]>;
  /** Asks the named thread's running job to stop. */
  abort(name: ThreadName): void;
  /** Asks every thread that watches an unverified child to check it again. */
  settle(): void;
  /** Waits for every running job, then ends every thread. */
  close(): Promise<void>;
}

/**
 * stimd's worker threads, each started on its first job and ended once it has had none for two minutes and watches no
 * unverified child. A job's unverified cleanup that names one child is watched on its thread, which releases what the
 * child held once it has stopped; the job's rejection then names that child and says whether it has stopped. A thread
 * that ends while it still watches a child reports `onLost`, since nothing can release what that child held any more.
 */
export function createThreadTable(log: Log, onLost: (error: Error) => void = () => {}): ThreadTable {
  const threads = new Map<ThreadName, Thread>();
  const idleEnd = (name: ThreadName, thread: Thread) => {
    thread.idle = setTimeout(() => {
      if (thread.unsettled.size === 0) end(name, thread);
      else idleEnd(name, thread);
    }, IDLE_MS);
    thread.idle.unref();
  };
  const end = (name: ThreadName, thread: Thread) => {
    if (thread.idle) clearTimeout(thread.idle);
    if (threads.get(name) === thread) threads.delete(name);
    void thread.worker.terminate();
  };
  const start = (name: ThreadName): Thread => {
    const worker = new Worker(spawnEntry('stimd-thread'), {
      workerData: { stimdThread: name },
    });
    const thread: Thread = { worker, pending: null, idle: null, unsettled: new Set(), lost: false };
    worker.on('message', (message: FromThread) => {
      if (message.type === 'log') return log(message.level, message.event, message.msg, message.fields);
      if (message.type === 'settled') {
        thread.unsettled = new Set(message.pending);
        return;
      }
      const pending = thread.pending;
      thread.pending = null;
      idleEnd(name, thread);
      if (message.type === 'done') return pending?.resolve(message.result);
      const child = message.contained;
      const key = child ? childKey({ reportChild: child }) : null;
      if (key) thread.unsettled.add(key);
      pending?.reject(
        Object.assign(new Error(message.message), {
          ...(message.code ? { code: message.code } : {}),
          ...(message.remedy ? { remedy: message.remedy } : {}),
          ...(message.reportCleanup ? { reportCleanup: true } : {}),
          ...(key ? { reportChild: child, cleanupSettled: () => !thread.unsettled.has(key) } : {}),
        }),
      );
    });
    const gone = (error: Error) => {
      if (threads.get(name) === thread) threads.delete(name);
      if (thread.unsettled.size > 0 && !thread.lost) {
        thread.lost = true;
        onLost(
          Object.assign(
            new Error(`the ${name} thread ended while a child whose cleanup was not verified may still run`),
            {
              code: 'STIM_CLAIM_UNAVAILABLE',
              reportCleanup: true,
              remedy: `Verify the ${name} thread's child processes and their descendants have stopped.`,
            },
          ),
        );
      }
      thread.pending?.reject(
        Object.assign(error, {
          code: 'STIM_CLAIM_UNAVAILABLE',
          reportCleanup: true,
          remedy: `Verify the ${name} thread's child processes and their descendants have stopped.`,
        }),
      );
      thread.pending = null;
    };
    worker.on('error', gone);
    worker.on('exit', (code) => gone(new Error(`the ${name} thread exited with code ${code}`)));
    threads.set(name, thread);
    return thread;
  };
  return {
    run(name, input) {
      const thread = threads.get(name) ?? start(name);
      if (thread.pending) return Promise.reject(new Error(`the ${name} thread is busy`));
      if (thread.idle) clearTimeout(thread.idle);
      thread.idle = null;
      return new Promise((resolve, reject) => {
        thread.pending = { resolve, reject };
        try {
          thread.worker.postMessage({ type: 'run', input });
        } catch (error) {
          thread.pending = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    abort(name) {
      const thread = threads.get(name);
      if (thread?.pending) thread.worker.postMessage({ type: 'abort' });
    },
    settle() {
      for (const thread of threads.values())
        if (thread.unsettled.size > 0) thread.worker.postMessage({ type: 'settle' });
    },
    async close() {
      await Promise.all(
        [...threads.entries()].map(async ([name, thread]) => {
          if (thread.pending) {
            const { resolve, reject } = thread.pending;
            await new Promise<void>((done) => {
              thread.pending = {
                resolve: (result) => (resolve(result), done()),
                reject: (error) => (reject(error), done()),
              };
            });
          }
          end(name, thread);
        }),
      );
    },
  };
}

/**
 * The slow passes on the passes thread: the fingerprint precompute, the dormant stage's dependency step and an automatic
 * maintenance pass, from the measurement of the tick that started them, one run at a time, so they never hold the tick
 * that serves waiting runs.
 */
export function createPassesLane(
  threads: ThreadTable,
  log: Log,
  onCleanupFailure?: (error: unknown) => boolean,
): MaintenanceLane {
  let current: Promise<void> | null = null;
  let failure: unknown;
  let taken: DaemonLadderAction[] = [];
  return {
    start({ config, measured, workspaces, pressure }, act) {
      if (current) return;
      current = threads
        .run('passes', {
          config,
          measured,
          workspaces,
          pressure,
          act,
          cwd: process.cwd(),
        })
        .then((actions) => void taken.push(...actions))
        .catch((error: unknown) => {
          if (error instanceof Error && 'reportCleanup' in error && !onCleanupFailure?.(error)) failure = error;
          log('warn', 'daemon_maintenance_failed', error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          current = null;
        });
    },
    running: () => current !== null,
    take() {
      const actions = taken;
      taken = [];
      return actions;
    },
    settled: async () => {
      await current;
      if (failure) throw failure;
    },
  };
}

const thread: ThreadName | 'logs' | undefined = isMainThread ? undefined : workerData?.stimdThread;
if (thread === 'logs') await import('./logs/writer-thread.ts');
else if (thread && parentPort) {
  const port = parentPort;
  const log: Log = (level, event, msg, fields = {}) => port.postMessage({ type: 'log', level, event, msg, fields });
  const { processContext } = await import('../cli-operation.ts');
  let lane: MaintenanceLane | undefined;
  serveThreadJobs<ThreadInput>(
    port,
    processContext,
    async (input, operation) => {
      if ('act' in input) {
        const { createMaintenanceLane } = await import('../daemon/passes.ts');
        lane ??= createMaintenanceLane(log);
        lane.start({ ...input, operation }, input.act);
        await lane.settled();
        return lane.take();
      }
      const { measureDependencyTrees } = await import('../daemon/dependencies.ts');
      await measureDependencyTrees(operation);
      return [];
    },
    () => {
      lane = undefined;
    },
  );
}
