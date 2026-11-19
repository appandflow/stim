import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import serve from '../commands/serve.ts';
import { runCli } from '../cli/define-op.ts';
import { trackWorker } from '../stimd/workers.ts';

const state = vi.hoisted((): { worker: Worker | null; exited: boolean } => ({ worker: null, exited: false }));

vi.mock('../stimd/main.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stimd/main.ts')>()),
  runStimd: async () => {
    const worker = trackWorker(new Worker('setInterval(() => {}, 1000);', { eval: true }));
    await once(worker, 'online');
    worker.once('exit', () => (state.exited = true));
    state.worker = worker;
    return true;
  },
}));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-serve-workers-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(async () => {
  await state.worker?.terminate();
  state.worker = null;
  state.exited = false;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('stim serve that owned the home ends the worker threads its stimd left before it returns', async () => {
  await runCli(serve, ['--port', '0', '--loopback-only'], { version: '9.9.9' });
  expect(state.worker).not.toBeNull();
  expect(state.exited).toBe(true);
});
