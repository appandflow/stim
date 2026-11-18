import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import { runStatusWatch } from './commands/status.ts';

const STOP_EXIT_MS = 500;

const cwd: unknown = workerData?.cwd;
const port: MessagePort | null = workerData?.port ?? parentPort;
port?.postMessage({ started: true });
const watch = runStatusWatch({
  json: true,
  ...(typeof cwd === 'string' ? { cwd } : {}),
  emit: (line) => port?.postMessage({ line }),
  failed: (message) => port?.postMessage({ failed: message }),
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  watch.stop(() => {
    port?.postMessage({ stopped: true });
    port?.close();
    setTimeout(() => process.exit(0), STOP_EXIT_MS);
  });
};
port?.on('message', (message: unknown) => {
  if (message === 'stop') stop();
});
port?.on('close', stop);
