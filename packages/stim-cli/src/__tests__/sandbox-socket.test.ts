import { EventEmitter } from 'node:events';
import { vi, expect, test } from 'vitest';

const socket = vi.hoisted(() => {
  const paths: string[] = [];
  return { code: 'ENOENT', deniedPath: '', paths };
});
vi.mock('net', () => ({
  connect(path: string) {
    socket.paths.push(path);
    const connection = new EventEmitter();
    queueMicrotask(() =>
      connection.emit(
        'error',
        Object.assign(new Error(socket.code), { code: path === socket.deniedPath ? 'EACCES' : socket.code }),
      ),
    );
    return connection;
  },
}));

import { sandboxBlocksSocket } from '../diagnostics/sandbox.ts';
import { engineLockSocket } from '../engine-store/locks.ts';

test.skipIf(process.platform === 'win32')('checks the actual stimd and engine lock endpoints', async () => {
  const env = { STIM_ENGINE_ROOT: '/private/tmp/stim-test-engine' };
  const lock = engineLockSocket(env.STIM_ENGINE_ROOT);
  const flip = engineLockSocket(env.STIM_ENGINE_ROOT, '.flip.sock');
  socket.paths = [];
  socket.code = 'ENOENT';
  socket.deniedPath = '';
  await expect(sandboxBlocksSocket('/allowed/stimd.sock', env)).resolves.toBe(false);
  expect(socket.paths).toEqual(['/allowed/stimd.sock', lock, flip]);
  socket.deniedPath = flip;
  await expect(sandboxBlocksSocket('/allowed/stimd.sock', env)).resolves.toBe(true);
  socket.deniedPath = lock;
  await expect(sandboxBlocksSocket('/allowed/stimd.sock', env)).resolves.toBe(true);
  socket.deniedPath = '/allowed/stimd.sock';
  await expect(sandboxBlocksSocket('/allowed/stimd.sock', env)).resolves.toBe(true);
});
