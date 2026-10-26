import { connect as connectSocket, type Socket } from 'node:net';
import type { BuildConnection } from '../offload/client.ts';
import { hostConnector } from '../device-host/hosted-client.ts';

const IDLE_LINKS = 4;
const FRAME_BYTES = 32 * 1024;
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

export interface MetroLinkPool {
  close: () => void;
}

/**
 * Keeps `IDLE_LINKS` authenticated connections open to `machine`, each offered to `session`'s Metro bridge there. The
 * host pairs one with each connection the hosted device makes; this side then pipes it to loopback `metroPort` and
 * opens a replacement. `onReady` runs when the host holds a link after holding none, and `onLost` when no linked
 * connection to the host is left.
 */
export function openMetroLinks({
  machine,
  session,
  metroPort,
  onReady,
  onLost,
  onError,
}: {
  machine: string;
  session: string;
  metroPort: number;
  onReady: () => void;
  onLost: () => void;
  onError: (message: string) => void;
}): MetroLinkPool {
  const connect = hostConnector(machine);
  const live = new Set<BuildConnection>();
  const linked = new Set<BuildConnection>();
  const waiting = new Set<BuildConnection>();
  const streams = new Set<Socket>();
  let opening = 0;
  let failures = 0;
  let misses = 0;
  let ready = false;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const fill = () => {
    if (closed || retry) return;
    while (opening + waiting.size < IDLE_LINKS) {
      opening++;
      void link();
    }
  };

  const gone = (connection: BuildConnection) => {
    live.delete(connection);
    waiting.delete(connection);
    if (!linked.delete(connection) || closed || !ready || linked.size > 0) return;
    ready = false;
    onLost();
  };

  const failed = (message: string, refused: boolean) => {
    if (closed) return;
    misses++;
    if (!ready && (refused || misses >= IDLE_LINKS)) onError(message);
    if (retry) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        fill();
      },
      RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)],
    );
    retry.unref();
  };

  const carry = (connection: BuildConnection, ended: () => void) => {
    const metro = connectSocket({ host: '127.0.0.1', port: metroPort });
    streams.add(metro);
    metro.on('error', () => metro.destroy());
    metro.once('close', () => {
      streams.delete(metro);
      ended();
      void connection.flushed().then(() => connection.close());
    });
    connection.onDropped((code) => (code === 1000 ? metro.end() : metro.destroy()));
    let paused = false;
    connection.onBinary((frame) => {
      if (metro.write(frame) || paused) return;
      paused = true;
      connection.pause();
      metro.once('drain', () => {
        paused = false;
        connection.resume();
      });
    });
    metro.on('data', (chunk: Buffer) => {
      metro.pause();
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES)
          await connection.sendBinary(chunk.subarray(offset, offset + FRAME_BYTES));
        if (!metro.destroyed) metro.resume();
      })();
    });
  };

  const link = async () => {
    let connection: BuildConnection | undefined;
    try {
      connection = await connect();
      if (closed) return void connection.close();
      live.add(connection);
      if (!connection.supports('hosted-metro-link'))
        throw Object.assign(
          new Error(`${machine} runs a stim-server that cannot link Metro. Update stim-server there, then retry.`),
          { refused: true },
        );
      const each = connection;
      let paired = false;
      let ended = false;
      each.onEvent((event) => {
        if (event.event !== 'device-host.metro.link.open' || paired || closed) return;
        paired = true;
        waiting.delete(each);
        carry(each, () => {
          ended = true;
          gone(each);
        });
        fill();
      });
      let registered = false;
      each.onDropped(() => {
        if (paired || !registered) return;
        gone(each);
        fill();
      });
      const reply = await each.request('device-host.metro.link', { session });
      if ('error' in reply)
        throw Object.assign(new Error(`${machine} refused the Metro link: ${reply.error.message}`), {
          refused: reply.error.code !== 'closed' && reply.error.code !== 'timeout',
        });
      if (closed) return void each.close();
      if (ended || each.failure) return void live.delete(each);
      registered = true;
      linked.add(each);
      if (!paired) waiting.add(each);
      each.watch();
      failures = 0;
      misses = 0;
      if (!ready) {
        ready = true;
        onReady();
      }
    } catch (error) {
      if (connection) live.delete(connection);
      connection?.close();
      failed(
        error instanceof Error ? error.message : String(error),
        typeof error === 'object' &&
          error !== null &&
          (('refused' in error && error.refused === true) ||
            ('code' in error && typeof error.code === 'string' && error.code.startsWith('STIM_'))),
      );
    } finally {
      opening--;
      fill();
    }
  };

  fill();
  return {
    close: () => {
      closed = true;
      clearTimeout(retry);
      for (const connection of live) connection.close();
      for (const stream of streams) stream.destroy();
      live.clear();
      linked.clear();
      waiting.clear();
    },
  };
}
