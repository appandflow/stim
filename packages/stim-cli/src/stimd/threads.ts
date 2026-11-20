import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import type { DiskPassInput, DiskPassResult, MaintenanceLane } from '../daemon/passes.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { childKey } from './cleanup-watch.ts';
import { setReportChildLog } from '../report-child-log.ts';
import { serveThreadJobs } from './thread-jobs.ts';
import { trackWorker } from './workers.ts';

type ThreadName = 'passes' | 'measure';
type PassesInput = Omit<Parameters<MaintenanceLane['start']>[0], 'operation'> & { act: boolean; cwd: string };
type ThreadInput = PassesInput | { cwd: string; buildEnd?: true };
type Log = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

const IDLE_MS = 2 * 60_000;

interface Failure {
  message: string;
  code?: string;
  remedy?: string;
  reportCleanup?: boolean;
  contained?: { pid: number; processToken: string | null };
}

type FromThread =
  | {
      type: 'log';
      level: Parameters<Log>[0];
      event: string;
      msg: string;
      fields: Record<string, unknown>;
    }
  | { type: 'done'; result: DaemonLadderAction[]; reading: boolean }
  | ({ type: 'failed'; reading: boolean } & Failure)
  | { type: 'settled'; pending: string[]; reading: boolean }
  | { type: 'ladderDone'; id: number; reading: boolean; result?: DiskPassResult; failure?: Failure };

interface Thread {
  worker: Worker;
  pending: {
    resolve: (result: DaemonLadderAction[]) => void;
    reject: (error: Error) => void;
  } | null;
  idle: NodeJS.Timeout | null;
  /** The children whose cleanup a job on this thread could not verify, which the thread itself watches. */
  unsettled: Set<string>;
  /** A read of this thread timed out and has not settled; a replacement thread would start another. */
  reading: boolean;
  /** Disk passes asked of this thread and not answered yet, by request id. */
  ladders: Map<number, { resolve: (result: DiskPassResult) => void; reject: (error: Error) => void }>;
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
  /**
   * Runs one disk pass on the passes thread, the stim-daemon's disk owner, beside the job it runs: the pass takes the
   * owner's turn at the job's next unit boundary.
   */
  ladder?(input: DiskPassInput): Promise<DiskPassResult>;
}

const lostError = (name: ThreadName, error: Error) =>
  Object.assign(error, {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
    remedy: `Verify the ${name} thread's child processes and their descendants have stopped.`,
  });

/**
 * stimd's worker threads, each started on its first job and ended once it has had none for two minutes, watches no
 * unverified child and has no timed-out read pending. A job's unverified cleanup that names one child is watched on its thread, which releases what the
 * child held once it has stopped; the job's rejection then names that child and says whether it has stopped. A thread
 * that ends while it still watches a child reports `onLost`, since nothing can release what that child held any more.
 */
export function createThreadTable(log: Log, onLost: (error: Error) => void = () => {}): ThreadTable {
  const threads = new Map<ThreadName, Thread>();
  const dependencyCadence = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const unownedCadence = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  let nextLadder = 0;
  const idleEnd = (name: ThreadName, thread: Thread) => {
    if (thread.idle) clearTimeout(thread.idle);
    thread.idle = null;
    if (thread.pending || thread.ladders.size) return;
    thread.idle = setTimeout(() => {
      thread.idle = null;
      if (thread.pending || thread.ladders.size) return;
      if (thread.unsettled.size === 0 && !thread.reading) return end(name, thread);
      if (thread.reading) thread.worker.postMessage({ type: 'settle' });
      idleEnd(name, thread);
    }, IDLE_MS);
    thread.idle.unref();
  };
  const end = (name: ThreadName, thread: Thread) => {
    if (thread.idle) clearTimeout(thread.idle);
    if (threads.get(name) === thread) threads.delete(name);
    void thread.worker.terminate();
  };
  const start = (name: ThreadName): Thread => {
    const worker = trackWorker(
      new Worker(spawnEntry('stimd-thread'), {
        workerData: { stimdThread: name, ...(name === 'passes' ? { dependencyCadence, unownedCadence } : {}) },
      }),
    );
    const thread: Thread = {
      worker,
      pending: null,
      idle: null,
      unsettled: new Set(),
      reading: false,
      lost: false,
      ladders: new Map(),
    };
    const rejection = (failure: Failure) => {
      const child = failure.contained;
      const key = child ? childKey({ reportChild: child }) : null;
      if (key) thread.unsettled.add(key);
      return Object.assign(new Error(failure.message), {
        ...(failure.code ? { code: failure.code } : {}),
        ...(failure.remedy ? { remedy: failure.remedy } : {}),
        ...(failure.reportCleanup ? { reportCleanup: true } : {}),
        ...(key ? { reportChild: child, cleanupSettled: () => !thread.unsettled.has(key) } : {}),
      });
    };
    worker.on('message', (message: FromThread) => {
      if (message.type === 'log') return log(message.level, message.event, message.msg, message.fields);
      if (message.type === 'settled') {
        thread.unsettled = new Set(message.pending);
        thread.reading = message.reading;
        return;
      }
      thread.reading = message.reading;
      if (message.type === 'ladderDone') {
        const asked = thread.ladders.get(message.id);
        thread.ladders.delete(message.id);
        idleEnd(name, thread);
        if (message.result) return asked?.resolve(message.result);
        return asked?.reject(rejection(message.failure ?? { message: 'the disk pass failed' }));
      }
      const pending = thread.pending;
      thread.pending = null;
      idleEnd(name, thread);
      if (message.type === 'done') return pending?.resolve(message.result);
      pending?.reject(rejection(message));
    });
    const gone = (error: Error) => {
      if (threads.get(name) === thread) threads.delete(name);
      for (const asked of thread.ladders.values())
        asked.reject(lostError(name, new Error(`the ${name} thread ended during a disk pass`)));
      thread.ladders.clear();
      if (thread.idle) clearTimeout(thread.idle);
      thread.idle = null;
      thread.reading = false;
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
      thread.pending?.reject(lostError(name, error));
      thread.pending = null;
    };
    worker.on('error', gone);
    worker.on('exit', (code) => gone(new Error(`the ${name} thread exited with code ${code}`)));
    threads.set(name, thread);
    return thread;
  };
  return {
    ladder(input) {
      const thread = threads.get('passes') ?? start('passes');
      if (thread.idle) clearTimeout(thread.idle);
      thread.idle = null;
      const id = ++nextLadder;
      return new Promise((resolve, reject) => {
        thread.ladders.set(id, { resolve, reject });
        try {
          thread.worker.postMessage({ type: 'ladder', id, input: { ...input, cwd: process.cwd() } });
        } catch (error) {
          thread.ladders.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
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
      if (thread && (thread.pending || thread.ladders.size)) thread.worker.postMessage({ type: 'abort' });
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
  const dependencyCadence: BigInt64Array | undefined = workerData.dependencyCadence;
  const log: Log = (level, event, msg, fields = {}) => port.postMessage({ type: 'log', level, event, msg, fields });
  setReportChildLog(log);
  const { processContext } = await import('../cli-operation.ts');
  const unownedCadence: BigInt64Array | undefined = workerData.unownedCadence;
  let lane: MaintenanceLane | undefined;
  serveThreadJobs<ThreadInput, DiskPassInput, DiskPassResult>(
    port,
    processContext,
    async (input, operation) => {
      if ('act' in input) {
        const { createMaintenanceLane } = await import('../daemon/passes.ts');
        lane ??= createMaintenanceLane(log, undefined, dependencyCadence);
        lane.start({ ...input, operation }, input.act);
        await lane.settled();
        return lane.take();
      }
      const { measureBuildEnds, measureDependencyTrees } = await import('../daemon/dependencies.ts');
      if (input.buildEnd) {
        const { timedStep } = await import('../daemon/step-timing.ts');
        await timedStep(
          log,
          'build_end_measure',
          async (tally) => {
            tally.items = await measureBuildEnds(operation);
          },
          { signal: operation.signal },
        );
      } else await measureDependencyTrees(operation);
      return [];
    },
    () => {
      lane = undefined;
    },
    async (input, operation) => {
      const { runDiskPass } = await import('../daemon/passes.ts');
      return runDiskPass(input, log, operation, unownedCadence);
    },
  );
}
