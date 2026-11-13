import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stimdSocket } from '@stim-cli/core/state';
import { holdCIStimd } from '../stimd/attached.ts';

test('cancelling CI admission closes its unanswered daemon socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ci-admission-'));
  vi.stubEnv('STIM_HOME', home);
  const path = stimdSocket();
  mkdirSync(dirname(path), { recursive: true });
  let received: () => void = () => {};
  let closed: () => void = () => {};
  const request = new Promise<void>((resolve) => {
    received = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let connection: Socket | undefined;
  const server = createServer((socket) => {
    connection = socket;
    socket.on('data', received);
    socket.on('close', closed);
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
  const controller = new AbortController();
  try {
    const hold = holdCIStimd({ ...process.env, STIM_HOME: home }, home, null, controller.signal);
    await request;
    controller.abort();
    await expect(hold).rejects.toMatchObject({ name: 'AbortError' });
    await disconnected;
  } finally {
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
