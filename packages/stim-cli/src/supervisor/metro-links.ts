import { connect as connectSocket, type Socket } from 'node:net';
import type { BuildConnection } from '../offload/client.ts';
import { connectHost } from '../device-host/hosted-client.ts';

const IDLE_LINKS = 4;
const FRAME_BYTES = 32 * 1024;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface MetroLinkPool {
  close: () => void;
}

/**
 * Keeps `IDLE_LINKS` authenticated connections open to `machine`, each offered to `session`'s Metro bridge there. The
 * host pairs one with each connection the hosted device makes; this side then pipes it to loopback `metroPort` and
 * opens a replacement.
 */
export function openMetroLinks({
  machine,
  session,
  metroPort,
  onReady,
  onError,
  connect = async (name) => (await connectHost(name, undefined, true)).connection,
}: {
  machine: string;
  session: string;
  metroPort: number;
  onReady: () => void;
  onError: (message: string) => void;
  connect?: (machine: string) => Promise<BuildConnection>;
}): MetroLinkPool {
  const live = new Set<BuildConnection>();
  const waiting = new Set<BuildConnection>();
  const streams = new Set<Socket>();
  let opening = 0;
  let failures = 0;
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

  const failed = (message: string) => {
    if (closed) return;
    if (!ready) onError(message);
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

  const carry = (connection: BuildConnection) => {
    const metro = connectSocket({ host: '127.0.0.1', port: metroPort });
    streams.add(metro);
    metro.on('error', () => metro.destroy());
    metro.once('close', () => {
      streams.delete(metro);
      live.delete(connection);
      connection.close();
    });
    connection.onDropped(() => metro.destroy());
    connection.onBinary((frame) => metro.write(frame));
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
      connection = await connect(machine);
      if (closed) return void connection.close();
      live.add(connection);
      if (!connection.supports('hosted-metro-link'))
        throw new Error(`${machine} runs a stim-server that cannot link Metro. Update stim-server there, then retry.`);
      const linked = connection;
      let opened = false;
      linked.onEvent((event) => {
        if (event.event !== 'device-host.metro.link.open' || opened || closed) return;
        opened = true;
        waiting.delete(linked);
        carry(linked);
        fill();
      });
      linked.onDropped(() => {
        if (opened) return;
        live.delete(linked);
        waiting.delete(linked);
        failed(`The link to ${machine} closed.`);
      });
      const reply = await linked.request('device-host.metro.link', { session });
      if ('error' in reply) throw new Error(`${machine} refused the Metro link: ${reply.error.message}`);
      if (closed || linked.failure) return void linked.close();
      if (!opened) waiting.add(linked);
      failures = 0;
      if (!ready) {
        ready = true;
        onReady();
      }
    } catch (error) {
      if (connection) live.delete(connection);
      connection?.close();
      failed(error instanceof Error ? error.message : String(error));
    } finally {
      opening--;
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
      waiting.clear();
    },
  };
}
