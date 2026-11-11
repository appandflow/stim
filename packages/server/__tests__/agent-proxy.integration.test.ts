import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { agentRoute, newAgentToken, type AgentDriverTarget, type HostedAgentDriver } from '@stim-cli/agent-driver';
import { HostedAgentHost } from '../src/agent-driver.ts';

const SESSION = '11111111-1111-4111-8111-111111111111';

const servers: Server[] = [];
const hosts: HostedAgentHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

/** A host whose one session's driver listens on `port`, served on its own port. */
async function hostFor(port: number): Promise<number> {
  const target: AgentDriverTarget = { port, path: `/secret/${SESSION}` };
  const driver: HostedAgentDriver = {
    name: 'agent-device',
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    issue: () => Promise.resolve({ driver: 'agent-device', token: newAgentToken(), scope: SESSION }),
    revoke: () => Promise.resolve(),
    target: () => Promise.resolve(target),
    onExit: () => () => undefined,
  };
  const agents = new HostedAgentHost({ resolve: () => driver, approved: () => true });
  hosts.push(agents);
  const access = await agents.appRunning({ client: 'c', session: SESSION, bundleId: 'dev.app', pid: 42 });
  const token = 'token' in access.grant ? access.grant.token : null;
  return listen(createServer((request, response) => void agents.forward(SESSION, token, request, response)));
}

function send(
  port: number,
  headers: Record<string, string> = {},
  body = '{}',
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: `${agentRoute(SESSION)}rpc`, headers },
      (answer) => {
        let text = '';
        answer.on('data', (chunk: Buffer) => (text += chunk.toString()));
        answer.once('end', () => resolve({ status: answer.statusCode ?? 0, text }));
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  return listen(createServer(handler));
}

test('the client credentials and hop-by-hop headers never reach the driver', async () => {
  let seen: IncomingMessage['headers'] = {};
  let url = '';
  const port = await hostFor(
    await upstream((request, response) => {
      seen = request.headers;
      url = request.url ?? '';
      response.writeHead(200).end('{}');
    }),
  );
  await send(port, {
    authorization: 'Bearer client-secret',
    'x-agent-device-token': 'client-secret',
    cookie: 'session=client-secret',
    te: 'trailers',
    trailer: 'x-checksum',
    'proxy-authorization': 'Basic client-secret',
    connection: 'x-hop',
    'x-hop': 'hop',
    'x-request-id': 'r1',
  });
  expect(url).toBe(`/secret/${SESSION}/rpc`);
  expect(seen['x-request-id']).toBe('r1');
  for (const name of [
    'authorization',
    'x-agent-device-token',
    'cookie',
    'te',
    'trailer',
    'proxy-authorization',
    'x-hop',
  ])
    expect(seen).not.toHaveProperty(name);
  expect(JSON.stringify(seen)).not.toContain('client-secret');
  await send(port, {
    connection: 'content-length, content-type, transfer-encoding',
    'content-length': '2',
    'content-type': 'application/json',
  });
  expect(seen).toMatchObject({ 'content-length': '2', 'content-type': 'application/json' });
});

test('request and response bodies stream through the hop', async () => {
  const sent = 'x'.repeat(2 * 1024 * 1024);
  const port = await hostFor(
    await upstream((request, response) => {
      let size = 0;
      request.on('data', (chunk: Buffer) => (size += chunk.length));
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write(String(size));
        response.end('y'.repeat(1024 * 1024));
      });
    }),
  );
  const answer = await send(port, {}, sent);
  expect(answer.status).toBe(200);
  expect(answer.text).toBe(`${sent.length}${'y'.repeat(1024 * 1024)}`);
});

test('a client that goes away ends the request to the driver', async () => {
  let reached: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  let closed: (finished: boolean) => void = () => undefined;
  const finished = new Promise<boolean>((resolve) => (closed = resolve));
  const port = await hostFor(
    await upstream((request, response) => {
      response.once('close', () => closed(response.writableFinished));
      reached();
      request.resume();
    }),
  );
  const outgoing = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${agentRoute(SESSION)}rpc` });
  outgoing.once('error', () => undefined);
  outgoing.write('{');
  await arrived;
  outgoing.destroy();
  expect(await finished).toBe(false);
});

test('a driver listener that refuses or resets answers that agent control is not running', async () => {
  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const address = free.address();
  const gone = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => free.close(resolve));
  expect(await send(await hostFor(gone))).toEqual({ status: 503, text: 'Agent control is not running.\n' });
  const reset = await hostFor(await upstream((request) => request.socket.destroy()));
  expect(await send(reset)).toEqual({ status: 503, text: 'Agent control is not running.\n' });
});
