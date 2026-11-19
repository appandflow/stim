import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workers = fileURLToPath(new URL('../stimd/workers.ts', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-workers-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a process that tracks one worker running `body`, then ends its workers and exits 0. */
async function endingProcess(body: string): Promise<{ code: number | null; signal: string | null; out: string }> {
  const script = `
import { Worker } from 'node:worker_threads';
import { endWorkers, trackWorker } from ${JSON.stringify(workers)};
const worker = trackWorker(new Worker(${JSON.stringify(`const { parentPort } = process.getBuiltinModule('node:worker_threads'); ${body}`)}, { eval: true }));
await new Promise((ready) => worker.once('message', ready));
await endWorkers(1000, (count) => {
  console.log('stuck ' + count);
  process.kill(process.pid, 'SIGKILL');
});
console.log('ended');
process.exit(0);
`;
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const [code, signal] = await once(child, 'exit');
  return { code, signal, out };
}

describe.skipIf(process.platform === 'win32')('ending stimd workers before process.exit (POSIX fifo)', () => {
  test('a worker whose filesystem read never returns cannot keep the process alive: it is killed at the deadline', async () => {
    const fifo = join(dir, 'fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const result = await endingProcess(
      `process.getBuiltinModule('node:fs').readFile(${JSON.stringify(fifo)}, () => {}); parentPort.postMessage('reading'); setInterval(() => {}, 1000);`,
    );
    expect(result).toEqual({ code: null, signal: 'SIGKILL', out: 'stuck 1\n' });
  }, 20_000);

  test('a worker that can stop is terminated and the process exits on its own', async () => {
    const result = await endingProcess(`parentPort.postMessage('idle'); setInterval(() => {}, 1000);`);
    expect(result).toEqual({ code: 0, signal: null, out: 'ended\n' });
  }, 20_000);
});
