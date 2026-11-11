import { Agent, createServer, request as httpRequest, type Server } from 'node:http';
import { agentRoute, newAgentToken, type AgentDriverTarget, type HostedAgentDriver } from '@stim-cli/agent-driver';
import { HostedAgentHost } from '../src/agent-driver.ts';

const SESSION = '11111111-1111-4111-8111-111111111111';
const REQUESTS = 500;

const servers: Server[] = [];

afterEach(async () => {
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

function timed(agent: Agent, port: number, path: string): Promise<number> {
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', agent }, (answer) => {
      answer.resume();
      answer.once('end', () => resolve(Number(process.hrtime.bigint() - started) / 1e6));
    });
    outgoing.once('error', reject);
    outgoing.end('{}');
  });
}

async function p50(port: number, path: string): Promise<number> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (let warm = 0; warm < 20; warm++) await timed(agent, port, path);
    const samples: number[] = [];
    for (let index = 0; index < REQUESTS; index++) samples.push(await timed(agent, port, path));
    return samples.toSorted((a, b) => a - b)[Math.floor(REQUESTS / 2)] ?? Number.POSITIVE_INFINITY;
  } finally {
    agent.destroy();
  }
}

test('the proxied hop to a driver adds at most 1 ms to the median agent request', async () => {
  const driverPort = await listen(createServer((_request, response) => response.writeHead(200).end('{}')));
  const target: AgentDriverTarget = { port: driverPort, path: `/secret/${SESSION}` };
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
  try {
    const access = await agents.appRunning({ client: 'c', session: SESSION, bundleId: 'dev.app', pid: 42 });
    const token = 'token' in access.grant ? access.grant.token : null;
    const hostPort = await listen(
      createServer((request, response) => void agents.forward(SESSION, token, request, response)),
    );
    const direct = await p50(driverPort, `${target.path}/rpc`);
    const proxied = await p50(hostPort, `${agentRoute(SESSION)}rpc`);
    expect(proxied - direct).toBeLessThanOrEqual(1);
  } finally {
    await agents.close();
  }
});
