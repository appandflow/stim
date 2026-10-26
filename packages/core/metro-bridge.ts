import { createServer, type Server, type Socket } from 'node:net';

export interface MetroBridge {
  server: Server;
  close: () => Promise<void>;
}

/** A client-initiated connection waiting to carry one Metro TCP stream. */
export interface MetroLink {
  /**
   * Takes over the accepted worker socket, which is paused, and owns it until either side closes. False when the link
   * is already closing; the socket is untouched and the bridge tries another link.
   */
  open: (socket: Socket) => boolean;
  /** Ends a link that never carried a stream. */
  close: () => void;
}

/** The idle links a hosted session's client keeps open; a bridge takes one per accepted connection. */
export interface MetroLinks {
  /** False when the links are closed or already hold `METRO_LINK_LIMIT` idle links; the caller closes the link. */
  add: (link: MetroLink) => boolean;
  remove: (link: MetroLink) => void;
  /** Resolves the oldest idle link, waiting at most `waitMs` for one; null when none arrived or the links closed. */
  take: (waitMs: number) => Promise<MetroLink | null>;
  close: () => void;
}

const METRO_LINK_LIMIT = 16;
const METRO_LINK_WAIT_MS = 10_000;

export function createMetroLinks(): MetroLinks {
  const idle: MetroLink[] = [];
  const waiting: ((link: MetroLink | null) => void)[] = [];
  let closed = false;
  return {
    add: (link) => {
      if (closed) return false;
      const waiter = waiting.shift();
      if (waiter) {
        waiter(link);
        return true;
      }
      if (idle.length >= METRO_LINK_LIMIT) return false;
      idle.push(link);
      return true;
    },
    remove: (link) => {
      const index = idle.indexOf(link);
      if (index >= 0) idle.splice(index, 1);
    },
    take: (waitMs) => {
      const link = idle.shift();
      if (link || closed) return Promise.resolve(link ?? null);
      return new Promise((resolve) => {
        const waiter = (taken: MetroLink | null) => {
          clearTimeout(timer);
          resolve(taken);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          resolve(null);
        }, waitMs);
        waiting.push(waiter);
      });
    },
    close: () => {
      closed = true;
      for (const link of idle.splice(0)) link.close();
      for (const waiter of waiting.splice(0)) waiter(null);
    },
  };
}

/** Bind this endpoint only to worker loopback; each accepted connection rides one link its client opened. */
export function createMetroBridge(
  links: Pick<MetroLinks, 'add' | 'take'>,
  waitMs: number = METRO_LINK_WAIT_MS,
): MetroBridge {
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closing || sockets.size >= 128) return void socket.destroy();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.pause();
    void (async () => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const link = await links.take(Math.max(0, deadline - Date.now()));
        if (!link) return void socket.destroy();
        if (socket.destroyed) return void (links.add(link) || link.close());
        if (link.open(socket)) return;
      }
    })();
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
