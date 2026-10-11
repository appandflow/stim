import { parentPort, workerData } from 'node:worker_threads';
import { runStatusWatch } from './commands/status.ts';

const cwd: unknown = workerData?.cwd;
const watch = runStatusWatch({
  json: true,
  ...(typeof cwd === 'string' ? { cwd } : {}),
  emit: (line) => parentPort?.postMessage({ line }),
  failed: (message) => parentPort?.postMessage({ failed: message }),
});
parentPort?.on('message', (message: unknown) => {
  if (message !== 'stop') return;
  watch.stop();
  parentPort?.close();
});
