import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { BuildConnection } from '../offload/client.ts';
import { hostConnector } from '../device-host/hosted-client.ts';
import { pipeLink } from './metro-links.ts';

export interface AgentRelay {
  /** The loopback port agent-device's remote config names; rejects when it cannot listen. */
  port: Promise<number>;
  close: () => void;
}

const MAX_CONNECTIONS = 8;

function refuse(socket: Socket, message: string): void {
  const body = `${message}\n`;
  socket.resume();
  socket.end(
    `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * Listens on a loopback port and carries each connection to `session`'s agent route on `machine` over its own
 * authenticated `device-host.agent.link` connection, so the host knows the request comes from this machine's key.
 * The host still requires the session's agent token in each request. A connection the host does not link is answered
 * with 502 and the reason. It holds at most 8 connections at a time, and listens on `port` when that is free, so a
 * remote config written for an earlier relay of the session still reaches it.
 */
export function openAgentRelay({
  machine,
  session,
  port: preferred,
}: {
  machine: string;
  session: string;
  port?: number;
}): AgentRelay {
  const connect = hostConnector(machine);
  const live = new Set<BuildConnection>();
  const sockets = new Set<Socket>();
  let closed = false;
  const relay = async (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let connection: BuildConnection | undefined;
    try {
      connection = await connect();
      if (closed || socket.destroyed) return void connection.close();
      if (!connection.supports('hosted-agent-link'))
        throw new Error(
          `${machine} runs a stim-server that cannot carry agent control over the local network. Update stim-server there, then retry.`,
        );
      const reply = await connection.request('device-host.agent.link', { session });
      if ('error' in reply) throw new Error(`${machine} refused the agent link: ${reply.error.message}`);
      if (closed || socket.destroyed) return void connection.close();
      const linked = connection;
      live.add(linked);
      pipeLink(linked, socket, () => live.delete(linked));
      socket.resume();
    } catch (error) {
      connection?.close();
      if (!socket.destroyed) refuse(socket, error instanceof Error ? error.message : String(error));
    }
  };
  const server = createServer({ pauseOnConnect: true }, (socket) => void relay(socket));
  server.maxConnections = MAX_CONNECTIONS;
  server.on('error', () => {});
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  const port = preferred ? listen(preferred).catch(() => listen(0)) : listen(0);
  port.catch(() => {});
  return {
    port,
    close: () => {
      closed = true;
      server.close();
      for (const connection of live) connection.close();
      for (const socket of sockets) socket.destroy();
      live.clear();
    },
  };
}
