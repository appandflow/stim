import type { Server } from 'node:net';

/**
 * Binds stimd's named pipe. Windows refuses a second server on a pipe name that is open (`EADDRINUSE`) and removes the
 * name when its last handle closes, so there is no leftover to probe or delete as with a Unix socket. The pipe's
 * default security descriptor gives write access only to its creator, administrators and LocalSystem.
 */
export function listenPipe(path: string, server: Server): Promise<void> {
  return new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      done();
    });
  });
}
