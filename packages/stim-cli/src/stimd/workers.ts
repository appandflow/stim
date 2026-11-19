import type { Worker } from 'node:worker_threads';
import { awakeTimeout } from './awake-timer.ts';

const running = new Set<Worker>();

/** Records `worker` until it exits, so `endWorkers` can wait for it before stimd's process exits. */
export function trackWorker<T extends Worker>(worker: T): T {
  running.add(worker);
  worker.once('exit', () => running.delete(worker));
  return worker;
}

/**
 * Terminates every tracked worker that still runs and resolves once each has exited. Calls `stuck` with the count
 * still running after `deadlineMs` of awake time, then resolves. `process.exit` joins worker threads, and a worker whose filesystem
 * request waits on a libuv thread never joins, so stimd waits here, where its timers still run, before it exits.
 */
export async function endWorkers(deadlineMs: number, stuck: (count: number) => void): Promise<void> {
  if (running.size === 0) return;
  const exited = Promise.all(
    [...running].map(
      (worker) =>
        new Promise<void>((done) => {
          worker.once('exit', () => done());
          worker.terminate().catch(() => {});
        }),
    ),
  );
  let cancel: (() => void) | undefined;
  await Promise.race([
    exited,
    new Promise<void>((done) => {
      cancel = awakeTimeout(deadlineMs, () => {
        stuck(running.size);
        done();
      });
    }),
  ]);
  cancel?.();
}
