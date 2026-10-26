import { connect as connectSocket, type Socket } from 'node:net';
import type { BuildConnection } from '../offload/client.ts';
import { hostConnector } from '../device-host/hosted-client.ts';

const IDLE_LINKS = 4;
const FRAME_BYTES = 32 * 1024;
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];
const METRO_RESET = 4410;

export interface MetroLinkPool {
  close: () => void;
}

/**
 * Keeps `IDLE_LINKS` authenticated connections open to `machine`, each offered to `session`'s Metro bridge there. The
 * host pairs one with each connection the hosted device makes; this side then pipes it to loopback `metroPort` and
 * opens a replacement. `onReady` runs when the host holds a link after holding none, and `onLost` when no linked
 * connection to the host is left. Failures that a retry can fix are retried. A host that turns this machine away calls
 * `onError` and stops the pool, and so does a refused link before the host ever held one; after that, refused links
 * are retried, since a session the host restarted refuses links until its client attaches again.
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
  let ready = false;
  let linkedOnce = false;
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

  const failed = (message: string, refused: 'host' | 'link' | null) => {
    if (closed) return;
    if (refused === 'host' || (refused === 'link' && !linkedOnce)) {
      stop();
      onError(message);
      return;
    }
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
    metro.once('close', (hadError) => {
      streams.delete(metro);
      ended();
      void connection.flushed().then(() => connection.close(hadError ? METRO_RESET : 1000));
    });
    connection.onDropped((code) => (code === 1000 ? metro.end() : metro.resetAndDestroy()));
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
          { code: 'STIM_HOSTING_REFUSED' },
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
          linkRefused: reply.error.code !== 'closed' && reply.error.code !== 'timeout',
        });
      if (closed) return void each.close();
      if (ended || each.failure) return void live.delete(each);
      registered = true;
      linked.add(each);
      if (!paired) waiting.add(each);
      each.watch();
      failures = 0;
      clearTimeout(retry);
      retry = undefined;
      if (!ready) {
        ready = true;
        linkedOnce = true;
        onReady();
      }
    } catch (error) {
      if (connection) live.delete(connection);
      connection?.close();
      const refused =
        typeof error !== 'object' || error === null
          ? null
          : 'code' in error && typeof error.code === 'string' && error.code.startsWith('STIM_')
            ? 'host'
            : 'linkRefused' in error && error.linkRefused === true
              ? 'link'
              : null;
      failed(error instanceof Error ? error.message : String(error), refused);
    } finally {
      opening--;
      fill();
    }
  };

  function stop() {
    closed = true;
    clearTimeout(retry);
    for (const connection of live) connection.close();
    for (const stream of streams) stream.destroy();
    live.clear();
    linked.clear();
    waiting.clear();
  }

  fill();
  return { close: stop };
}
