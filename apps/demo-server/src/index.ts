import { DurableObject } from 'cloudflare:workers';

import { DemoMachine, type DemoConnection, type Device } from './demo.ts';
import { bundledFixtures } from './fixtures.ts';

interface Env {
  DEMO: DurableObjectNamespace<DemoServer>;
  DEMO_TOKEN?: string;
}

const MACHINE_NAME = 'Demo Mac';

export default {
  fetch(request, env): Promise<Response> | Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Stim demo server. Pair the Stim app with this address over wss://.\n', { status: 426 });
    }
    return env.DEMO.get(env.DEMO.idFromName('demo')).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class DemoServer extends DurableObject<Env> {
  private readonly machine: DemoMachine = new DemoMachine(bundledFixtures(), MACHINE_NAME, this.env.DEMO_TOKEN);
  private readonly connections = new Map<WebSocket, DemoConnection>();

  override fetch(): Response {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    await this.connection(socket).receive(message);
  }

  override webSocketClose(socket: WebSocket): void {
    this.drop(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.drop(socket);
  }

  private connection(socket: WebSocket): DemoConnection {
    let connection = this.connections.get(socket);
    if (!connection) {
      connection = this.machine.connect(
        {
          send: (text) => socket.send(text),
          close: () => socket.close(1008, 'hello failed'),
          remember: (device) => socket.serializeAttachment(device),
        },
        socket.deserializeAttachment() as Device | null,
      );
      this.connections.set(socket, connection);
    }
    return connection;
  }

  private drop(socket: WebSocket): void {
    this.connections.get(socket)?.close();
    this.connections.delete(socket);
  }
}
