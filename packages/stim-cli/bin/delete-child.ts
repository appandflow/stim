import { createInterface } from 'node:readline';
import { runRmJob, type RmJob } from '../src/workspace/remover.ts';

const PROGRESS_MS = 1000;
const cwd = { chdir: (path: string) => process.chdir(path), current: () => process.cwd() };

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

let running: { id: number; controller: AbortController } | null = null;
const queue: RmJob[] = [];

async function drain(): Promise<void> {
  if (running) return;
  for (let job = queue.shift(); job; job = queue.shift()) {
    const controller = new AbortController();
    running = { id: job.id, controller };
    let entries = 0;
    let reportedAt = 0;
    const outcome = await runRmJob(job, controller.signal, {
      cwd,
      removed: () => {
        entries++;
        const now = performance.now();
        if (reportedAt && now - reportedAt < PROGRESS_MS) return;
        reportedAt = now;
        send({ id: job.id, progress: { entries } });
      },
    });
    running = null;
    send({ id: job.id, ...outcome });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message: Record<string, unknown> | null;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;
  if ('cancel' in message) {
    if (running && running.id === message.cancel) running.controller.abort();
    return;
  }
  const { id, op, path, dev } = message;
  if (op === 'rm' && typeof id === 'number' && typeof path === 'string' && typeof dev === 'number') {
    queue.push({ id, op, path, dev });
    void drain();
  }
});
lines.on('close', () => {
  queue.length = 0;
  running?.controller.abort();
});
send({ ready: true });
