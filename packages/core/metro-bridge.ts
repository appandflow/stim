import { timingSafeEqual } from 'node:crypto';
import { connect, createServer, isIP, type Server, type Socket } from 'node:net';

export interface MetroBridge {
  server: Server;
  close: () => Promise<void>;
}

function port(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid Metro bridge port.');
}

function credential(secret: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('A Metro bridge needs a 256-bit secret.');
  return Buffer.from(`${secret}\n`, 'ascii');
}

function trackedServer(accept: (socket: Socket, track: (socket: Socket) => void) => void): MetroBridge {
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const server = createServer((socket) => {
    if (closing || sockets.size >= 128) return void socket.destroy();
    track(socket);
    accept(socket, track);
  });
  return {
    server,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

function forward(source: Socket, target: Socket): void {
  source.once('close', () => target.destroy());
  target.once('close', () => source.destroy());
  source.pipe(target).pipe(source);
}

/** Bind this gateway only to the client's own Tailscale address; `peer` is the pinned worker's literal address. */
export function createMetroGateway({
  metroPort,
  peer,
  secret,
}: {
  metroPort: number;
  peer: string;
  secret: string;
}): MetroBridge {
  port(metroPort);
  if (!isIP(peer)) throw new Error('The Metro gateway requires a pinned peer address.');
  const expected = credential(secret);
  return trackedServer((socket, track) => {
    const address = socket.remoteAddress?.replace(/^::ffff:/, '');
    if (address !== peer) return void socket.destroy();
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(deadline));
    let prefix = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      const needed = expected.length - prefix.length;
      prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
      if (prefix.length < expected.length) return;
      socket.removeListener('data', authenticate);
      socket.pause();
      if (!timingSafeEqual(prefix, expected)) return void socket.destroy();
      clearTimeout(deadline);
      const upstream = connect({ host: '127.0.0.1', port: metroPort });
      track(upstream);
      if (chunk.length > needed) socket.unshift(chunk.subarray(needed));
      forward(socket, upstream);
    };
    socket.on('data', authenticate);
  });
}

/** Bind this endpoint only to worker loopback; `peer` comes from the approved client's authenticated connection. */
export function createMetroBridge({
  gatewayPort,
  peer,
  secret,
}: {
  gatewayPort: number;
  peer: string;
  secret: string;
}): MetroBridge {
  port(gatewayPort);
  if (!isIP(peer)) throw new Error('The Metro bridge requires an authenticated peer address.');
  const prefix = credential(secret);
  return trackedServer((socket, track) => {
    socket.pause();
    const upstream = connect({ host: peer, port: gatewayPort, timeout: 5000 });
    track(upstream);
    upstream.once('timeout', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      upstream.write(prefix);
      forward(socket, upstream);
    });
    socket.once('close', () => upstream.destroy());
  });
}
