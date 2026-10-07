import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseHostedAgentGrant, type HostedAgentGrant } from '@stim-cli/core/state';
import {
  AgentDriverUnavailable,
  HostedAgentHost,
  agentRoute,
  newAgentToken,
  type HostedAgentApp,
  type HostedAgentDriver,
} from '../src/agent-driver.ts';

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
  issue(app: HostedAgentApp): Promise<HostedAgentGrant> {
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

const NODES: Record<string, string> = { 'client-1': 'node-1', 'client-2': 'node-2' };

function host(
  driver: FakeDriver | null,
  nodeOf: (client: string) => string | null = (client) => NODES[client] ?? null,
) {
  return new HostedAgentHost({ resolve: () => driver, nodeOf, restartDelayMs: 0 });
}

const tokenOf = (grant: HostedAgentGrant): string => (grant.driver === 'none' ? '' : grant.token);

async function call(
  agents: HostedAgentHost,
  session: string,
  token: string | null,
  node: string | null,
): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => {
    agents.forward(session, token, node, request, response);
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
  test('starts with the first app, stops after the last and starts again for a later one', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const first = await agents.appRunning(app(A, 10, 'client-1'));
    const second = await agents.appRunning(app(B, 11, 'client-2'));
    expect(first.grant.driver).toBe('agent-device');
    expect(second.grant.driver).toBe('agent-device');
    expect(driver.starts).toBe(1);
    await agents.appStopped(A);
    expect(driver.running).toBe(true);
    expect(driver.revoked).toEqual([A]);
    await agents.appStopped(B);
    expect(driver.running).toBe(false);
    expect(driver.stops).toBe(1);
    await agents.appRunning(app(A, 12, 'client-1'));
    expect(driver.starts).toBe(2);
    await agents.close();
    expect(driver.running).toBe(false);
  });

  test('keeps one grant for a running app and replaces it when the process changes', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const first = await agents.appRunning(app(A, 10, 'client-1'));
    expect(await agents.appRunning(app(A, 10, 'client-1'))).toEqual(first);
    const relaunched = await agents.appRunning(app(A, 99, 'client-1'));
    expect(tokenOf(relaunched.grant)).not.toBe(tokenOf(first.grant));
    expect(agents.authorize(A, tokenOf(first.grant), 'node-1')).toBe('forbidden');
    expect(agents.authorize(A, tokenOf(relaunched.grant), 'node-1')).toBe('ok');
    expect(driver.starts).toBe(1);
    expect(driver.stops).toBe(0);
    await agents.close();
  });

  test('hands out no driver when the setting names none, without starting anything', async () => {
    const agents = host(null);
    expect(await agents.appRunning(app(A, 10, 'client-1'))).toEqual({ grant: { driver: 'none' } });
    expect(agents.access(A)).toEqual({ grant: { driver: 'none' } });
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
    expect(agents.authorize(B, 'anything', 'node-2')).toBe('unknown');
    await agents.close();
  });

  test('shows a client only a generic message for an unexpected driver failure', async () => {
    const driver = new FakeDriver();
    driver.failStart = new Error('spawn failed with token abc');
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const access = await host(driver).appRunning(app(A, 10, 'client-1'));
      expect(JSON.stringify(access)).not.toContain('abc');
    } finally {
      write.mockRestore();
    }
  });

  test('restarts a crashed daemon, issues new grants and invalidates the old ones', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const before = await agents.appRunning(app(A, 10, 'client-1'));
    driver.crash();
    await vi.waitFor(() => expect(driver.starts).toBe(2));
    await vi.waitFor(() => expect(driver.running).toBe(true));
    const after = agents.access(A)!;
    expect(after.grant.driver).toBe('agent-device');
    expect(tokenOf(after.grant)).not.toBe(tokenOf(before.grant));
    expect(agents.authorize(A, tokenOf(before.grant), 'node-1')).toBe('forbidden');
    expect(agents.authorize(A, tokenOf(after.grant), 'node-1')).toBe('ok');
    await agents.close();
  });

  test('restarts again when the new daemon exits while grants are being reissued', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    await agents.appRunning(app(A, 10, 'client-1'));
    driver.crash();
    await vi.waitFor(() => expect(driver.starts).toBe(2));
    driver.crash();
    await vi.waitFor(() => expect(driver.starts).toBe(3));
    await vi.waitFor(() => expect(agents.access(A)?.grant.driver).toBe('agent-device'));
    await agents.close();
  });

  test('leaves no daemon running when it closes during a restart', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    await agents.appRunning(app(A, 10, 'client-1'));
    driver.startDelayMs = 30;
    driver.crash();
    await vi.waitFor(() => expect(driver.starts).toBe(2));
    await agents.close();
    expect(driver.running).toBe(false);
  });

  test('re-evaluates an app that has no driver grant when its session attaches again', async () => {
    const driver = new FakeDriver();
    driver.failStart = new AgentDriverUnavailable('not yet');
    const agents = host(driver);
    expect((await agents.appRunning(app(A, 10, 'client-1'))).grant.driver).toBe('none');
    driver.failStart = null;
    expect((await agents.appRunning(app(A, 10, 'client-1'))).grant.driver).toBe('agent-device');
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

  test('reach the driver only with the session token from the client node while the app runs', async () => {
    const driver = new FakeDriver();
    const agents = host(driver);
    const first = tokenOf((await agents.appRunning(app(A, 10, 'client-1'))).grant);
    const second = tokenOf((await agents.appRunning(app(B, 11, 'client-2'))).grant);

    expect(await call(agents, A, first, 'node-1')).toEqual({ status: 200, body: 'forwarded' });
    expect(driver.forwarded).toEqual([A]);

    const refused: [string, string, string | null, string | null, number][] = [
      ['another session token', A, second, 'node-1', 403],
      ['no token', A, null, 'node-1', 403],
      ['a wrong token', A, `${first}x`, 'node-1', 403],
      ['another node', A, first, 'node-2', 403],
      ['an unidentified node', A, first, null, 403],
      ['an unknown session', '33333333-3333-4333-8333-333333333333', first, 'node-1', 404],
    ];
    for (const [, session, token, node, status] of refused)
      expect((await call(agents, session, token, node)).status).toBe(status);
    expect(driver.forwarded).toEqual([A]);

    await agents.appStopped(A);
    expect((await call(agents, A, first, 'node-1')).status).toBe(404);
    expect(await call(agents, B, second, 'node-2')).toEqual({ status: 200, body: 'forwarded' });
    await agents.close();
  });

  test('stop working as soon as the client loses its device-host approval', async () => {
    const driver = new FakeDriver();
    let approved = true;
    const agents = host(driver, (client) => (approved ? (NODES[client] ?? null) : null));
    const token = tokenOf((await agents.appRunning(app(A, 10, 'client-1'))).grant);
    expect(agents.authorize(A, token, 'node-1')).toBe('ok');
    approved = false;
    expect(agents.authorize(A, token, 'node-1')).toBe('forbidden');
    await agents.close();
  });
});

test.each(['ios', 'android'])(
  '%s sessions have separate daemon lifetimes, grants and restarts beside the shared macOS driver',
  async (platform) => {
    const macos = new FakeDriver();
    const drivers = new Map<string, FakeDriver>();
    const agents = new HostedAgentHost({
      resolve: () => macos,
      resolveDevice: (target) => {
        const driver = new FakeDriver();
        drivers.set(target.session, driver);
        return driver;
      },
      nodeOf: (client) => NODES[client] ?? null,
      restartDelayMs: 0,
    });
    const ios = (session: string, client: string, udid: string): HostedAgentApp => ({
      session,
      client,
      ...(platform === 'ios' ? { udid } : { serial: session === A ? 'emulator-5554' : 'emulator-5556' }),
      bundleId: 'dev.app',
    });
    const first = await agents.appRunning(ios(A, 'client-1', A));
    const second = await agents.appRunning(ios(B, 'client-2', B));
    const mac = await agents.appRunning(app('33333333-3333-4333-8333-333333333333', 5, 'client-1'));
    try {
      expect(drivers.get(A)).not.toBe(drivers.get(B));
      expect(agents.authorize(A, tokenOf(first.grant), 'node-1')).toBe('ok');
      expect(agents.authorize(A, tokenOf(second.grant), 'node-1')).toBe('forbidden');
      expect(agents.authorize(A, tokenOf(first.grant), 'node-2')).toBe('forbidden');
      drivers.get(A)!.crash();
      await vi.waitFor(() => expect(drivers.get(A)!.starts).toBe(2));
      await vi.waitFor(() => expect(tokenOf(agents.access(A)!.grant)).not.toBe(tokenOf(first.grant)));
      expect(agents.access(B)).toEqual(second);
      expect(macos.starts).toBe(1);
      await agents.appStopped(A);
      expect(drivers.get(A)!.running).toBe(false);
      expect(drivers.get(B)!.running).toBe(true);
      expect(agents.access(B)).toEqual(second);
      expect(mac.grant.driver).toBe('agent-device');
    } finally {
      await agents.close();
    }
    expect(drivers.get(B)!.running).toBe(false);
    expect(macos.running).toBe(false);
  },
);

test.each(['ios', 'android'])(
  '%s none starts no daemon, and a failed daemon stop refuses replacement',
  async (platform) => {
    const driver = new FakeDriver();
    let enabled = false;
    const agents = new HostedAgentHost({
      resolve: () => null,
      resolveDevice: () => (enabled ? driver : null),
      nodeOf: () => 'node',
    });
    const target: HostedAgentApp = {
      session: A,
      client: 'client',
      ...(platform === 'ios' ? { udid: A } : { serial: 'emulator-5554' }),
      bundleId: 'dev.app',
    };
    expect((await agents.appRunning(target)).grant.driver).toBe('none');
    expect(driver.starts).toBe(0);
    enabled = true;
    expect((await agents.appRunning(target)).grant.driver).toBe('agent-device');
    const stop = vi.spyOn(driver, 'stop').mockRejectedValue(new Error('daemon unresolved'));
    await expect(agents.appStopped(A)).rejects.toThrow('daemon unresolved');
    expect(agents.authorize(A, 'old', 'node')).toBe('unknown');
    stop.mockRestore();
    await agents.close();
  },
);

test.each(['ios', 'android'])(
  'close attempts every %s daemon and macOS cleanup, retains failed children and retries their stop',
  async (platform) => {
    const macos = new FakeDriver();
    const first = new FakeDriver();
    const second = new FakeDriver();
    const agents = new HostedAgentHost({
      resolve: () => macos,
      resolveDevice: (target) => (target.session === A ? first : second),
      nodeOf: () => 'node',
    });
    await agents.appRunning({
      session: A,
      client: 'c',
      ...(platform === 'ios' ? { udid: A } : { serial: 'emulator-5554' }),
      bundleId: 'dev.app',
    });
    await agents.appRunning({
      session: B,
      client: 'c',
      ...(platform === 'ios' ? { udid: B } : { serial: 'emulator-5556' }),
      bundleId: 'dev.app',
    });
    const mac = '33333333-3333-4333-8333-333333333333';
    await agents.appRunning(app(mac, 10));
    const stop = vi.spyOn(first, 'stop').mockRejectedValue(new Error('daemon unresolved'));
    try {
      await expect(agents.close()).rejects.toMatchObject({
        errors: [expect.objectContaining({ errors: [expect.objectContaining({ message: 'daemon unresolved' })] })],
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(first.running).toBe(true);
      expect(second.running).toBe(false);
      expect(second.stops).toBe(1);
      expect(macos.running).toBe(false);
      expect(macos.revoked).toEqual([mac]);
      expect(agents.access(B)).toBeUndefined();
      expect(agents.access(mac)).toBeUndefined();
    } finally {
      stop.mockRestore();
      await agents.close();
    }
    expect(first.running).toBe(false);
    expect(agents.access(A)).toBeUndefined();
    expect(second.stops).toBe(1);
  },
);

test('retains a partially started iOS daemon until its shutdown is verified', async () => {
  const driver = new FakeDriver();
  const agents = new HostedAgentHost({ resolve: () => null, resolveDevice: () => driver, nodeOf: () => 'node' });
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
  expect(agents.authorize(A, 'old', 'node')).toBe('unknown');
  stop.mockRestore();
  await agents.close();
  expect(driver.running).toBe(false);
});
