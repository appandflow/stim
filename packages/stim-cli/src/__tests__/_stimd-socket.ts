import { mkdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { daemonClaimRoot, stimdSocket } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';

/** Takes the daemon claim as this process, as a running stimd does. */
export function holdDaemonClaim(): void {
  const claim = tryAcquireClaim({
    root: daemonClaimRoot(),
    mode: 'shared',
    label: 'stimd',
    details: { mode: 'on' },
  }).acquired;
  onTestFinished(() => {
    releaseClaim(claim);
  });
}

/** Listens on this home's stimd socket; a connection gets `reply` when it is not null, and silence otherwise. */
export async function serveStimdSocket(reply: string | null): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () => {
      if (reply !== null) socket.write(`${reply}\n`);
    });
  });
  if (process.platform !== 'win32') mkdirSync(dirname(stimdSocket()), { recursive: true });
  await new Promise<void>((done) => server.listen(stimdSocket(), done));
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  });
}
