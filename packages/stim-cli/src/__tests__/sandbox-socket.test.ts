import { EventEmitter } from 'node:events';
import { vi, expect, test } from 'vitest';

const socket = vi.hoisted(() => {
  const paths: string[] = [];
  return { code: 'ENOENT', paths };
});
vi.mock('net', () => ({
  connect(path: string) {
    socket.paths.push(path);
    const connection = new EventEmitter();
    queueMicrotask(() => connection.emit('error', Object.assign(new Error(socket.code), { code: socket.code })));
    return connection;
  },
}));

import { sandboxBlocksSocket } from '../diagnostics/sandbox.ts';

test.skipIf(process.platform === 'win32')('checks only the actual socket when it is absent or denied', async () => {
  socket.paths = [];
  socket.code = 'ENOENT';
  await expect(sandboxBlocksSocket('/allowed/stimd.sock')).resolves.toBe(false);
  expect(socket.paths).toEqual(['/allowed/stimd.sock']);
  socket.code = 'EACCES';
  await expect(sandboxBlocksSocket('/allowed/stimd.sock')).resolves.toBe(true);
});
