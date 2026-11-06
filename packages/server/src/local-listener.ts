import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectSocket, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { claimRemoveCommand, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';

/** What the Unix socket listener reads from and records into the server that starts it. */
export interface LocalListenerContext {
  readonly closing: boolean;
  readonly answerHealth: (response: ServerResponse) => Promise<void>;
  readonly upgradeLocal: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
  localListener: { server: Server; sockets: Set<Socket> } | null;
  localSocket: string | null;
}

const LOCAL_SOCKET_CLAIM_TRIES = 50;

/**
 * The Unix socket for this machine's own user. Node cannot read a Unix socket peer's uid, so the kernel's check
 * stands in for it: connecting needs write access to the socket, which is mode 0600 in a 0700 directory this user
 * owns. A socket file that no server answers on is stale and replaced. Windows has no local clients and no socket.
 */
export async function listenLocal(ctx: LocalListenerContext, path: string): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = lstatSync(dir);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()))
    throw new Error(`${dir} is not a directory this user owns, so stim-server does not put its local socket there.`);
  chmodSync(dir, 0o700);
  const claimRoot = `${path}.claims`;
  let attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'stim-server local socket' });
  for (let tries = 0; !attempt.acquired && tries < LOCAL_SOCKET_CLAIM_TRIES; tries++) {
    if (ctx.closing) break;
    if (attempt.pending) releaseClaim(attempt.pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'stim-server local socket' });
  }
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired) {
    const held = attempt.held?.path ?? claimRoot;
    throw new Error(
      `another stim-server holds ${held} while it opens its local socket. If nothing is using it, remove it with ${claimRemoveCommand(held)}.`,
    );
  }
  try {
    await bindLocal(ctx, path);
  } finally {
    releaseClaim(attempt.acquired);
  }
}
/** Probes, replaces and binds the socket while this server holds the socket's claim. */
async function bindLocal(ctx: LocalListenerContext, path: string): Promise<void> {
  if (existsSync(path)) {
    const answered = await new Promise<boolean>((resolve) => {
      const probe = connectSocket(path);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (answered) throw Object.assign(new Error(`another stim-server answers on ${path}`), { code: 'EADDRINUSE' });
    rmSync(path, { force: true });
  }
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') return void ctx.answerHealth(response);
    response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
  });
  server.on('upgrade', ctx.upgradeLocal);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  ctx.localListener = { server, sockets };
  ctx.localSocket = path;
}
