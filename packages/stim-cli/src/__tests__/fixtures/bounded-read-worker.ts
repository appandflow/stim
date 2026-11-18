import { parentPort, threadId } from 'node:worker_threads';
import { processContext } from '../../cli-operation.ts';
import { serveThreadJobs } from '../../stimd/thread-jobs.ts';
import { answered } from '../../workspace/bounded-read.ts';

/** A stimd thread whose job reads a stuck folder through the bounded read, or with `release` lets that read settle. */
if (parentPort) {
  const port = parentPort;
  let settle: (() => void) | null = null;
  let started = 0;
  serveThreadJobs<{ release?: boolean }>(port, processContext, async ({ release }) => {
    if (release) {
      settle?.();
      await new Promise((done) => setImmediate(done));
    } else
      await answered(
        '/stuck',
        () => {
          started++;
          return new Promise<void>((done) => (settle = done));
        },
        10,
      ).catch(() => {});
    port.postMessage({ type: 'log', level: 'info', event: 'fixture', msg: '', fields: { threadId, started } });
    return [];
  });
}
