import type { StimContext } from '@stim-cli/core';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { Config } from '../workspace/config.ts';
import type { HistoryRoot } from '../fsevents-helper.ts';
import type { CleanupQueueStatus, DaemonLadderAction, BuildEndMarker, GcMarkHealth } from '@stim-cli/core/state';
import type {
  DiskPassInput,
  DiskPassResult,
  MaintenanceLane,
  HeadroomRequest,
  HeadroomReply,
} from '../daemon/passes.ts';
import {
  LADDER,
  LADDER_CLOCK_SLOTS,
  reportDiskQueue,
  requestGcPass,
  requestGcItem,
  type GcPassReply,
} from '../daemon/disk-owner.ts';
import type { GcPassRequest } from '../commands/gc.ts';
import type { GcItemRequest, GcItemResult } from '../commands/gc/item.ts';
import { runGcItem } from './gc-item.ts';
import type { LevelRunAction } from './passes/level-run.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { childKey } from './cleanup-watch.ts';
import { setReportChildLog } from '../report-child-log.ts';
import { serveThreadJobs } from './thread-jobs.ts';
import { trackWorker } from './workers.ts';
import { dirtyGcMarks } from '../fsevents-state.ts';

type DirtyRequest = { dirty: { roots: readonly string[]; at: number } };
type DirtyReply = { dirty: true };
type HistoryRequest = { history: Config };
type HistoryReply = { roots: HistoryRoot[] | null; marks: GcMarkHealth };

type ThreadName = 'passes' | 'measure';
type PassesInput = Omit<Parameters<MaintenanceLane['start']>[0], 'operation'> & { act: boolean; cwd: string };
type ThreadInput = PassesInput | { cwd: string; buildEnd?: BuildEndMarker[] };
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
  | { type: 'diskQueue'; status: CleanupQueueStatus }
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
  | {
      type: 'ladderDone';
      id: number;
      reading: boolean;
      result?: DiskPassResult | GcPassReply | GcItemResult | HeadroomReply | DirtyReply | HistoryReply;
      failure?: Failure;
    }
  | { type: 'gcAction'; id: number; action: LevelRunAction }
  | { type: 'gcOutput'; id: number; stream: 'stdout' | 'stderr'; text: string };

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
  /** Disk passes and gc requests asked of this thread and not answered yet, by request id. */
  ladders: Map<
    number,
    {
      resolve: (
        result: DiskPassResult | GcPassReply | GcItemResult | HeadroomReply | DirtyReply | HistoryReply,
      ) => void;
      reject: (error: Error) => void;
    }
  >;
  /** Where each gc request's actions go, by request id. */
  gcActions: Map<number, (action: LevelRunAction) => void>;
  gcOutputs: Map<number, StimContext['output']>;
  lost: boolean;
}

export interface ThreadTable {
  /** Runs one job on the named thread, starting the thread first when it is not running. One job per thread at a time. */
  run(name: ThreadName, input: ThreadInput): Promise<DaemonLadderAction[]>;
  /** Asks the named thread's running job to stop. */
  abort(name: ThreadName): void;
  /** Asks every thread that watches an unverified child to check it again. */
  settle(): void;
  /** Waits for every running job, disk pass and gc request, then ends every thread. */
  close(): Promise<void>;
  /**
   * Runs one disk pass on the passes thread, the stim-daemon's disk owner, beside the job it runs: the pass takes the
   * owner's turn at the job's next unit boundary.
   */
  ladder?(input: DiskPassInput): Promise<DiskPassResult>;
  /**
   * Sends one gc request to the passes thread, which joins a pass under way or queues one (`requestGcPass`); `leave`
   * withdraws it.
   */
  gc(
    input: GcPassRequest & { cwd: string },
    onAction: (action: LevelRunAction) => void,
  ): { result: Promise<GcPassReply>; leave(): void };
  /** Persists dirty marks on their writer's isolate before resolving. */
  dirty(roots: readonly string[], at: number): Promise<void>;
  history(config: Config): Promise<HistoryReply>;
  /** Queues a build's headroom turn, bounded by its original client deadline. */
  headroom(input: HeadroomRequest & { cwd: string; act: boolean }): { result: Promise<HeadroomReply>; leave(): void };
  /** Queues an explicit item independently and streams its operation's output. */
  item(
    input: GcItemRequest & { cwd: string },
    output: StimContext['output'],
  ): { result: Promise<GcItemResult>; leave(): void };
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
export function createThreadTable(
  log: Log,
  onLost: (error: Error) => void = () => {},
  onQueue: (status: CleanupQueueStatus) => void = () => {},
): ThreadTable {
  const threads = new Map<ThreadName, Thread>();
  const dependencyCadence = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const ladderClocks = new BigInt64Array(
    new SharedArrayBuffer(Object.keys(LADDER_CLOCK_SLOTS).length * BigInt64Array.BYTES_PER_ELEMENT),
  );
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
        workerData: { stimdThread: name, ...(name === 'passes' ? { dependencyCadence, ladderClocks } : {}) },
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
      gcActions: new Map(),
      gcOutputs: new Map(),
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
      if (message.type === 'diskQueue') {
        if (threads.get(name) === thread) onQueue(message.status);
        return;
      }
      if (message.type === 'log') return log(message.level, message.event, message.msg, message.fields);
      if (message.type === 'settled') {
        thread.unsettled = new Set(message.pending);
        thread.reading = message.reading;
        return;
      }
      if (message.type === 'gcOutput') return thread.gcOutputs.get(message.id)?.(message.stream, message.text);
      if (message.type === 'gcAction') return thread.gcActions.get(message.id)?.(message.action);
      thread.reading = message.reading;
      if (message.type === 'ladderDone') {
        const asked = thread.ladders.get(message.id);
        thread.ladders.delete(message.id);
        thread.gcActions.delete(message.id);
        thread.gcOutputs.delete(message.id);
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
      if (threads.get(name) === thread) {
        threads.delete(name);
        if (name === 'passes') onQueue({ running: null, queued: 0 });
      }
      for (const asked of thread.ladders.values())
        asked.reject(lostError(name, new Error(`the ${name} thread ended during a disk pass`)));
      thread.ladders.clear();
      thread.gcActions.clear();
      thread.gcOutputs.clear();
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
  const ask = <T extends DiskPassResult | GcPassReply | GcItemResult | HeadroomReply | DirtyReply | HistoryReply>(
    type: 'ladder' | 'gc',
    input: object,
    onAction?: (action: LevelRunAction) => void,
    output?: StimContext['output'],
  ) => {
    const thread = threads.get('passes') ?? start('passes');
    if (thread.idle) clearTimeout(thread.idle);
    thread.idle = null;
    const id = ++nextLadder;
    const result = new Promise<T>((resolve, reject) => {
      thread.ladders.set(id, {
        resolve: resolve as (
          result: DiskPassResult | GcPassReply | GcItemResult | HeadroomReply | DirtyReply | HistoryReply,
        ) => void,
        reject,
      });
      if (onAction) thread.gcActions.set(id, onAction);
      if (output) thread.gcOutputs.set(id, output);
      try {
        thread.worker.postMessage({ type, id, input });
      } catch (error) {
        thread.ladders.delete(id);
        thread.gcActions.delete(id);
        thread.gcOutputs.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { thread, id, result };
  };
  return {
    ladder: (input) => ask<DiskPassResult>('ladder', { ...input, cwd: process.cwd() }).result,
    gc(input, onAction) {
      const { thread, id, result } = ask<GcPassReply>('gc', input, onAction);
      return {
        result,
        leave: () => {
          if (thread.ladders.has(id)) thread.worker.postMessage({ type: 'gcLeave', id });
        },
      };
    },
    history(config) {
      return ask<HistoryReply>('gc', { history: config, cwd: process.cwd() }).result;
    },
    dirty(roots, at) {
      return ask<DirtyReply>('gc', { dirty: { roots, at }, cwd: process.cwd() }).result.then(() => undefined);
    },
    headroom(input) {
      const { thread, id, result } = ask<HeadroomReply>('gc', input);
      const leave = () => {
        if (thread.ladders.has(id)) thread.worker.postMessage({ type: 'gcLeave', id });
      };
      const timer = setTimeout(leave, Math.max(0, input.headroom.deadline - Date.now()));
      return { result: result.finally(() => clearTimeout(timer)), leave };
    },
    item(input, output) {
      const { thread, id, result } = ask<GcItemResult>('gc', input, undefined, output);
      return {
        result,
        leave: () => {
          if (thread.ladders.has(id)) thread.worker.postMessage({ type: 'gcLeave', id });
        },
      };
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
          await Promise.all(
            [...thread.ladders].map(
              ([id, { resolve, reject }]) =>
                new Promise<void>((done) => {
                  thread.ladders.set(id, {
                    resolve: (result) => (resolve(result), done()),
                    reject: (error) => (reject(error), done()),
                  });
                }),
            ),
          );
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
  const ladderClocks: BigInt64Array | undefined = workerData.ladderClocks;
  let lane: MaintenanceLane | undefined;
  if (thread === 'passes') reportDiskQueue((status) => port.postMessage({ type: 'diskQueue', status }));
  serveThreadJobs<
    ThreadInput,
    DiskPassInput,
    DiskPassResult,
    GcPassRequest | GcItemRequest | (HeadroomRequest & { act: boolean }) | DirtyRequest | HistoryRequest,
    GcPassReply | GcItemResult | HeadroomReply | DirtyReply | HistoryReply
  >(
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
            tally.items = await measureBuildEnds(operation, Date.now(), input.buildEnd);
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
      return runDiskPass(input, log, operation, ladderClocks);
    },
    (input, open, emit, output) => {
      if ('history' in input) {
        const controller = new AbortController();
        const operation = open(controller.signal);
        return {
          result: import('../daemon/mark-health.ts').then(({ readMarkHealth }): Promise<HistoryReply> =>
            readMarkHealth(input.history, operation),
          ),
          leave: () => controller.abort(),
        };
      }
      if ('dirty' in input)
        return {
          result: Promise.resolve().then((): DirtyReply => {
            dirtyGcMarks(input.dirty.roots, input.dirty.at);
            return { dirty: true };
          }),
          leave() {},
        };
      if ('headroom' in input)
        return requestGcItem(async (signal): Promise<HeadroomReply> => {
          const { runLadderToFree } = await import('../daemon/passes.ts');
          const operation = open(new AbortController().signal);
          await runLadderToFree({ ...input.headroom, operation, signal, act: input.act });
          return { headroom: true };
        }, LADDER);
      if ('item' in input)
        return requestGcItem((signal) => {
          const operation = open(signal);
          operation.output = output;
          return runGcItem(input.item, operation);
        });
      const { level, client, walkUnknown } = input;
      return requestGcPass(
        level,
        client,
        async (asked, signal, onAction, onLevel) => {
          const { runGcPass } = await import('../commands/gc.ts');
          const request = {
            ...(asked ? { level: asked } : {}),
            client,
            ...(walkUnknown === false ? { walkUnknown } : {}),
          };
          return runGcPass(request, open(signal), onAction, onLevel);
        },
        emit,
      );
    },
  );
}
