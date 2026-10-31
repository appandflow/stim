import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseHostedAgentGrant, type HostedAgentGrant, type HostedAgentIssuedGrant } from '@stim-cli/core/state';
import {
  AgentDriverUnavailable,
  agentRoute,
  newAgentToken,
  type HostedAgentApp,
  type HostedAgentDriver,
} from '@stim-cli/agent-driver';
import { HostedAgentHost, type AgentPeer } from '../src/agent-driver.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

class FakeDriver implements HostedAgentDriver {
  readonly name = 'agent-device';
  running = false;
  starts = 0;
  stops = 0;
  forwarded: string[] = [];
  revoked: string[] = [];
  failStart: Error | null = null;
  failIssue: Error | null = null;
  startFailures = 0;
  startDelayMs = 0;
  private listener: (() => void) | null = null;
  async start(): Promise<void> {
    this.starts += 1;
    if (this.startDelayMs) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    if (this.failStart) throw this.failStart;
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error('daemon would not start');
    }
    this.running = true;
  }
  stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
    return Promise.resolve();
  }
  issue(app: HostedAgentApp): Promise<HostedAgentIssuedGrant> {
    if (this.failIssue) return Promise.reject(this.failIssue);
    return Promise.resolve({
      driver: 'agent-device',
      path: agentRoute(app.session),
      token: newAgentToken(),
      scope: `lease-${app.session.slice(0, 8)}-${app.pid}`,
      lease: {
        tenant: `stim.${app.session}`,
        runId: app.session,
        clientId: 'agent',
        deviceKey: app.udid
          ? `ios:mobile:${app.udid}`
          : app.serial
            ? `android:mobile:${app.serial}`
            : `${app.bundleId}@${app.pid}`,
        ...(app.udid
          ? { backend: 'ios-instance' as const }
          : app.serial
            ? { backend: 'android-instance' as const }
            : {}),
      },
    });
  }
  revoke(session: string): Promise<void> {
    this.revoked.push(session);
    return Promise.resolve();
  }
  forward(session: string, _request: IncomingMessage, response: ServerResponse): void {
    this.forwarded.push(session);
    response.writeHead(200).end('forwarded');
  }
  onExit(listener: () => void): void {
    this.listener = listener;
  }
  crash(): void {
    this.running = false;
    this.listener?.();
  }
}

const app = (session: string, pid: number, client = `client-${session.slice(0, 1)}`): HostedAgentApp => ({
  client,
  session,
  bundleId: 'dev.example.app.hosted1',
  pid,
});

function host(driver: FakeDriver | null, approved: (client: string, from: AgentPeer) => boolean = () => true) {
  return new HostedAgentHost({ resolve: () => driver, approved, restartDelayMs: 0 });
}

const tokenOf = (grant: HostedAgentGrant): string => ('token' in grant ? grant.token : '');

async function call(
  agents: HostedAgentHost,
  session: string,
  token: string | null,
  from: AgentPeer = { node: null },
): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => {
    agents.forward(session, token, request, response, from);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/x' },
        (answer) => {
          let body = '';
          answer.on('data', (chunk: Buffer) => (body += chunk.toString()));
          answer.on('end', () => resolve({ status: answer.statusCode ?? 0, body }));
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('hosted agent driver lifecycle', () => {
  test('keeps one grant for a running app and replaces it when the process changes', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const first = await agents.appRunning(app(A, 10, 'client-1'));
    expect(await agents.appRunning(app(A, 10, 'client-1'))).toEqual(first);
    const relaunched = await agents.appRunning(app(A, 99, 'client-1'));
    expect(tokenOf(relaunched.grant)).not.toBe(tokenOf(first.grant));
    expect(agents.authorize(A, tokenOf(first.grant))).toBe('forbidden');
    expect(agents.authorize(A, tokenOf(relaunched.grant))).toBe('ok');
    expect(driver.starts).toBe(1);
    expect(driver.stops).toBe(0);
    await agents.close();
  });

  test('hands out none with the reason when the driver cannot scope or run, and keeps no daemon', async () => {
    const driver = new FakeDriver();
    driver.failStart = new AgentDriverUnavailable('no scoped lease yet');
    const agents = host(driver);
    expect(await agents.appRunning(app(A, 10, 'client-1'))).toEqual({
      grant: { driver: 'none' },
      notice: 'no scoped lease yet',
    });
    driver.failStart = null;
    driver.failIssue = new AgentDriverUnavailable('cannot scope');
    expect(await agents.appRunning(app(B, 11, 'client-2'))).toEqual({
      grant: { driver: 'none' },
      notice: 'cannot scope',
    });
    expect(driver.running).toBe(false);
    expect(driver.stops).toBe(1);
    expect(agents.authorize(B, 'anything')).toBe('unknown');
    await agents.close();
  });

  test('gives up after repeated restart failures and tells the client', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    await agents.appRunning(app(A, 10, 'client-1'));
    driver.startFailures = 10;
    driver.crash();
    await vi.waitFor(() => expect(agents.access(A)?.grant.driver).toBe('none'));
    expect(agents.access(A)?.notice).toMatch(/could not be restarted/);
    expect(driver.starts).toBe(1 + 3);
    expect(driver.running).toBe(false);
    await agents.close();
  });

  test('close revokes every grant, stops the driver and starts nothing afterwards', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    await agents.appRunning(app(A, 10, 'client-1'));
    await agents.appRunning(app(B, 11, 'client-2'));
    await agents.close();
    expect(driver.revoked.toSorted()).toEqual([A, B]);
    expect(driver.running).toBe(false);
    expect(await agents.appRunning(app(A, 12, 'client-1'))).toEqual({ grant: { driver: 'none' } });
    expect(driver.starts).toBe(1);
  });
});

describe('hosted agent grants', () => {
  test('are 256-bit tokens the client parser accepts', () => {
    const token = newAgentToken();
    expect(
      parseHostedAgentGrant({
        driver: 'agent-device',
        path: agentRoute(A),
        token,
        scope: 'lease-1',
        lease: { tenant: `stim.${A}`, runId: A, clientId: 'agent', deviceKey: 'dev.example.app@5' },
      }),
    ).not.toBeNull();
    expect(newAgentToken()).not.toBe(token);
  });

  test('reach the driver only with the session token while the app runs', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const first = tokenOf((await agents.appRunning(app(A, 10, 'client-1'))).grant);
    const second = tokenOf((await agents.appRunning(app(B, 11, 'client-2'))).grant);

    expect(await call(agents, A, first)).toEqual({ status: 200, body: 'forwarded' });
    expect(driver.forwarded).toEqual([A]);

    const refused: [string, string, string | null, number][] = [
      ['another session token', A, second, 403],
      ['no token', A, null, 403],
      ['a wrong token', A, `${first}x`, 403],
      ['an unknown session', '33333333-3333-4333-8333-333333333333', first, 404],
    ];
    for (const [, session, token, status] of refused) expect((await call(agents, session, token)).status).toBe(status);
    expect(driver.forwarded).toEqual([A]);

    await agents.appStopped(A);
    expect((await call(agents, A, first)).status).toBe(404);
    expect(await call(agents, B, second)).toEqual({ status: 200, body: 'forwarded' });
    await agents.close();
  });
});

test('retains a partially started iOS daemon until its shutdown is verified', async () => {
  const driver = new FakeDriver();
  const agents = new HostedAgentHost({ resolve: () => null, resolveDevice: () => driver, approved: () => true });
  vi.spyOn(driver, 'start').mockImplementation(() => {
    driver.running = true;
    return Promise.reject(new AgentDriverUnavailable('policy could not be verified'));
  });
  const stop = vi.spyOn(driver, 'stop').mockRejectedValue(new Error('daemon unresolved'));
  await expect(agents.appRunning({ session: A, client: 'client', udid: A, bundleId: 'dev.app' })).rejects.toThrow(
    'daemon unresolved',
  );
  await expect(agents.appStopped(A)).rejects.toThrow('daemon unresolved');
  expect(driver.running).toBe(true);
  expect(agents.authorize(A, 'old')).toBe('unknown');
  stop.mockRestore();
  await agents.close();
  expect(driver.running).toBe(false);
});
