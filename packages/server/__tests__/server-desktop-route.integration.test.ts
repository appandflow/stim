import {
  fakeTailscale,
  CLIENT,
  root,
  workspace,
  server,
  start,
  connect,
  pair,
  returning,
  desktop,
  alive,
  until,
  stimCalls,
  authed,
  forgetServer,
} from './server-harness.ts';
import assert from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import {
  buildLedgerFile,
  gcLogFile,
  type BuildPlanPayload,
  readStatsReport,
  workspaceMetadataFile,
  workspaceShareLinksFile,
  readSetupJournal,
} from '@stim-cli/core/state';
import { ShareHub, type StartedShare } from '../src/share.ts';
import * as stim from 'stim';
import * as stimSelf from 'stim/api-self';
import { type ServerMessage } from '../src/protocol.ts';
import { runNodeCommand } from '../src/stim-command.ts';
import {
  capabilitiesFor,
  createPairingToken,
  readBuildClients,
  readDeviceHostClients,
  dropSetupSecret,
  secretPsk,
  storeSetupSecret,
  watchClientRegistries,
} from '../src/registry.ts';
import { pruneSetupJournals, writeSetupJournal } from '../src/setup-journal.ts';
import { setupClaim, type SetupDeps } from '../src/setup.ts';
import { fetchHealth } from '../src/service.ts';
import type { InstalledService } from '../src/service-plist.ts';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { newSecret, secretValues } from '@stim-cli/core/noise-session';
import { localConnect, setupClient, type Client } from './noise-client.ts';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { ClaimUnavailableError, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { waitForPid } from '../../stim-cli/src/__tests__/_pid-file.ts';

describe.skipIf(!fakeTailscale)('Desktop route setup', () => {
  afterEach(() => vi.restoreAllMocks());

  async function routeServer(
    config: unknown = {},
    env: Record<string, string> = {},
    options: { shareServer?: { idle: () => void; graceMs?: number } } = {},
  ) {
    const status = join(root, 'serve.json');
    const commandLog = join(root, 'serve-calls.ndjson');
    writeFileSync(status, typeof config === 'string' ? config : JSON.stringify(config));
    const port = await start({
      tailscaleState: { state: 'running', dnsName: 'test.tail.ts.net', ips: [], hostName: 'test' },
      env: { FAKE_SERVE_STATUS: status, FAKE_SERVE_CALLS: commandLog, ...env },
      ...options,
    });
    return {
      port,
      status,
      commands: () =>
        existsSync(commandLog)
          ? readFileSync(commandLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as string[])
          : [],
    };
  }

  it('creates and verifies a private free-port proxy without changing other handlers or Funnel', async () => {
    const original = {
      TCP: { '443': { HTTPS: true }, '7443': { HTTPS: true } },
      Web: { 'test.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
      AllowFunnel: { 'test.tail.ts.net:443': true },
    };
    const fixture = await routeServer(original);
    const client = await desktop();
    expect(await client.request('route.setup', {})).toMatchObject({ result: { state: 'routed', port: 7444 } });
    expect(existsSync(join(root, 'home', 'server', 'tailnet.json'))).toBe(true);
    expect(fixture.commands()).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--bg', '--https=7444', `http://127.0.0.1:${fixture.port}`],
      ['serve', 'status', '--json'],
    ]);
    const config = JSON.parse(readFileSync(fixture.status, 'utf8'));
    expect(config.AllowFunnel).toEqual(original.AllowFunnel);
    expect(config.Web['test.tail.ts.net:443']).toEqual(original.Web['test.tail.ts.net:443']);
    expect(await client.request('route.setup')).toMatchObject({ result: { state: 'routed', port: 7444 } });
    expect(fixture.commands().filter((args) => args[1] !== 'status')).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', '{', 'not JSON'],
    ['unrecognized config', { Error: 'service unavailable' }, 'unrecognized'],
    ['malformed config', { TCP: [] }, 'malformed'],
    ['malformed foreground', { Foreground: { session: null } }, 'malformed'],
  ])('refuses %s before changing any route', async (_name, config, reason) => {
    const fixture = await routeServer(config);
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining(reason) },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it('refuses an existing public route rather than adding another or changing Funnel', async () => {
    const fixture = await routeServer();
    writeFileSync(
      fixture.status,
      JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: { 'test.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${fixture.port}` } } } },
        AllowFunnel: { 'test.tail.ts.net:443': true },
      }),
    );
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('Funnel') },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it.each([
    [
      'command refusal',
      { FAKE_SERVE_FAILURE: 'Enable HTTPS at https://login.tailscale.com/admin/dns' },
      'Enable HTTPS',
    ],
    ['unverified command success', { FAKE_SERVE_NO_CHANGE: '1' }, 'could not be verified'],
  ])('keeps %s readable and permits an explicit retry', async (_name, env, reason) => {
    const fixture = await routeServer({}, env);
    const client = await desktop();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await client.request('route.setup')).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining(reason) },
      });
    }
    expect(fixture.commands().filter((args) => args[1] !== 'status')).toHaveLength(2);
  });

  it('refuses a timed-out status probe without inferring that a route is missing', async () => {
    const fixture = await routeServer({}, { FAKE_SERVE_STATUS_HANG: '1' });
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('timed out') },
    });
    expect(fixture.commands()).toEqual([['serve', 'status', '--json']]);
  });

  it('bounds a stalled setup command and keeps the failure retryable', async () => {
    const fixture = await routeServer({}, { FAKE_SERVE_HANG: '1' });
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('setup timed out') },
    });
    expect(JSON.parse(readFileSync(fixture.status, 'utf8'))).toEqual({});
  }, 15_000);

  it('serves Desktop-only methods on the Unix socket and refuses them to a network connection with control', async () => {
    const fixture = await routeServer();
    const { keyPair } = await pair(fixture.port, '100.64.0.2', true);
    const remote = await returning(fixture.port, keyPair, '100.64.0.2');
    for (const [method, params] of [
      ['route.setup', undefined],
      ['machines.update.start', { machine: 'mini' }],
      ['machines.update.status', { machine: 'mini' }],
      ['device-host.sessions', undefined],
      ['device-host.sessions.stop', { session: 'missing' }],
      ['share.start', { workspace: root, platform: 'ios', control: true }],
      ['share.stop', { workspace: root }],
      ['share.list', undefined],
    ] as const) {
      expect(await remote.request(method, params)).toMatchObject({ error: { code: 'forbidden' } });
    }
    const loopback = await authed(fixture.port, true);
    expect(await loopback.request('route.setup')).toMatchObject({ error: { code: 'forbidden' } });
    expect(await loopback.request('share.start', { workspace: root, platform: 'ios' })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(fixture.commands()).toEqual([]);

    const local = await desktop();
    expect(await local.request('machines.update.start', {})).toMatchObject({ error: { code: 'bad-request' } });
    expect(await local.request('machines.update.start', { machine: 'mini' })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('has not approved this machine') },
    });
    expect(await local.request('machines.update.status', { machine: 'mini' })).toMatchObject({
      result: { remote: null, unreachable: expect.stringContaining('has not approved this machine'), upload: null },
    });
    expect(await local.request('route.setup')).toMatchObject({ result: { state: 'routed' } });
    expect(await local.request('share.list')).toEqual(expect.objectContaining({ result: { shares: [], starting: 0 } }));
    expect(await local.request('share.stop', { workspace: root })).toEqual(
      expect.objectContaining({ result: { stopped: [] } }),
    );
    expect(await local.request('share.stop', { workspace: root, id: 'w1' })).toMatchObject({
      error: { code: 'bad-request', message: expect.stringContaining('No share w1') },
    });
    expect(await local.request('share.stop', { workspace: root, id: '' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    for (const params of [
      { token: 'short' },
      { token: TOKEN, expiresAt: '2000-01-01T00:00:00.000Z' },
      { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString(), expiresMinutes: 30 },
      { token: TOKEN, expiresAt: new Date(Date.now() + 10 * 3600_000).toISOString() },
    ]) {
      expect(await local.request('share.start', { workspace: root, platform: 'ios', ...params })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
    expect(await local.request('share.stop', { workspace: root, slot: 'beta' })).toEqual(
      expect.objectContaining({ result: { stopped: [] } }),
    );
    for (const params of [
      { workspace: root, slot: 'not a slot' },
      { workspace: root, id: 'w1', slot: 'beta' },
    ]) {
      expect(await local.request('share.stop', params)).toMatchObject({ error: { code: 'bad-request' } });
    }
    for (const [params, message] of [
      [{ slug: 'Pokedex' }, 'params.slug must be'],
      [{ slug: 'assets' }, 'params.slug cannot be assets'],
      [{ slug: 'pokedex', passwordless: true }, 'needs a password'],
      [{ slug: 'pokedex', token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }, 'a slug or a token'],
    ] as const) {
      expect(await local.request('share.start', { workspace: root, platform: 'ios', ...params })).toMatchObject({
        error: { code: 'bad-request', message: expect.stringContaining(message) },
      });
    }
  });

  it('starts the saved live shares again when it starts, never a stopped one, and marks a share stopped before share.stop ends it', async () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const saved = {
      slot: 'default',
      physical: false,
      control: false,
      password: 'saved-password',
      auth: 'generated',
      viewAuth: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
    writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
    const origin = 'https://demo.example.com/s/';
    writeFileSync(
      join(String(process.env.STIM_HOME), 'config.json'),
      JSON.stringify({
        projects: { [workspace]: {} },
        share: { exposure: 'proxy', publicUrl: 'https://demo.example.com' },
      }),
    );
    const entries = {
      ios: { ...saved, platform: 'ios', token: TOKEN, origin, state: 'live' },
      'ios@tablet': { ...saved, platform: 'ios', slot: 'tablet', token: 'T'.repeat(43), origin, state: 'live' },
      android: { ...saved, platform: 'android', token: 'Z'.repeat(43), origin, state: 'stopped' },
    };
    writeFileSync(workspaceShareLinksFile(workspace), JSON.stringify({ version: 1, links: entries }));
    const started = vi
      .spyOn(ShareHub.prototype, 'start')
      .mockImplementation(async () => ({ id: 'w1', url: 'https://x.test/s/x/', expiresAt: saved.expiresAt }) as never);
    const order: string[] = [];
    vi.spyOn(ShareHub.prototype, 'stop').mockImplementation(async () => {
      order.push(`stop saw ${JSON.stringify(savedStates())}`);
      return [];
    });
    const savedStates = () =>
      Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(workspaceShareLinksFile(workspace), 'utf8')).links).map(
          ([key, link]) => [key, (link as { state: string }).state],
        ),
      );
    await routeServer();
    const client = await desktop();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace,
        platform: 'ios',
        token: TOKEN,
        password: 'saved-password',
        control: false,
        expiresAt: Date.parse(saved.expiresAt),
      }),
      { restore: true, origin },
    );
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ slot: 'tablet', token: 'T'.repeat(43) }), {
      restore: true,
      origin,
    });

    expect(JSON.parse(readFileSync(workspaceShareLinksFile(workspace), 'utf8')).links).toEqual(
      Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, expect.objectContaining(entry)])),
    );

    await client.request('share.stop', { workspace, slot: 'tablet' });
    expect(savedStates()).toEqual({ ios: 'live', 'ios@tablet': 'stopped', android: 'stopped' });
    await client.request('share.stop', { workspace });
    expect(savedStates()).toEqual({ ios: 'stopped', 'ios@tablet': 'stopped', android: 'stopped' });
    expect(order[0]).toBe('stop saw {"ios":"live","ios@tablet":"stopped","android":"stopped"}');
  });

  it('a share-only server lists the saved live share it restored, not an expired or stopped one, and ends once nothing is shared', async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    writeFileSync(
      join(String(process.env.STIM_HOME), 'config.json'),
      JSON.stringify({ projects: { [workspace]: {} }, share: { exposure: 'proxy', port } }),
    );
    const origin = `http://127.0.0.1:${port}/s/`;
    const saved = {
      slot: 'default',
      physical: false,
      control: false,
      password: 'saved-password',
      auth: 'generated',
      viewAuth: null,
      origin,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
    writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
    writeFileSync(
      workspaceShareLinksFile(workspace),
      JSON.stringify({
        version: 1,
        links: {
          ios: { ...saved, platform: 'ios', token: 'A'.repeat(43), state: 'live' },
          'ios@old': {
            ...saved,
            platform: 'ios',
            slot: 'old',
            token: 'B'.repeat(43),
            state: 'live',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
          android: { ...saved, platform: 'android', token: 'C'.repeat(43), state: 'stopped' },
        },
      }),
    );
    const idle = vi.fn<() => void>();
    await start({
      tailscaleState: { state: 'running', dnsName: 'test.tail.ts.net', ips: [], hostName: 'test' },
      shareServer: { idle, graceMs: 50 },
    });
    const client = await desktop();
    const listed = async () =>
      JSON.parse(JSON.stringify(await client.request('share.list'))).result.shares.map(
        (row: { slot: string }) => row.slot,
      );
    await vi.waitFor(async () => expect(await listed()).toEqual(['default']));
    expect(idle).not.toHaveBeenCalled();
    await client.request('share.stop', { workspace });
    await vi.waitFor(() => expect(idle).toHaveBeenCalledTimes(1));
    expect(await listed()).toEqual([]);
  });

  it('leaves a saved share stopped, and runs no Funnel or serve command, when it was shared under another address', async () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    writeFileSync(
      join(String(process.env.STIM_HOME), 'config.json'),
      JSON.stringify({
        projects: { [workspace]: {} },
        share: { exposure: 'proxy', publicUrl: 'https://other.example.com' },
      }),
    );
    mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
    writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
    writeFileSync(
      workspaceShareLinksFile(workspace),
      JSON.stringify({
        version: 1,
        links: {
          ios: {
            slot: 'default',
            physical: false,
            control: false,
            password: 'saved-password',
            auth: 'generated',
            viewAuth: null,
            platform: 'ios',
            token: TOKEN,
            origin: 'https://demo.example.com/s/',
            state: 'live',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      }),
    );
    const started = vi.spyOn(ShareHub.prototype, 'start');
    const fixture = await routeServer({}, {}, { shareServer: { idle: () => {}, graceMs: 50 } });
    expect(fixture.port).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(workspaceShareLinksFile(workspace), 'utf8')).links.ios.state).toBe('stopped'),
    );
    expect(started).not.toHaveBeenCalled();
    expect(fixture.commands()).toEqual([]);
  });

  it("saves a share started over share.start, keeps the first start's password kind on a start under the same link, and share.stop pauses it", async () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
    writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
    const started = (over: Partial<StartedShare>): StartedShare => ({
      id: 'w1',
      workspace,
      platform: 'ios',
      slot: 'default',
      physical: false,
      control: false,
      viewers: 0,
      auth: 'generated',
      viewAuth: null,
      url: `https://x.test/s/${TOKEN}/`,
      expiresAt,
      ...over,
    });
    const hub = vi.spyOn(ShareHub.prototype, 'start');
    hub.mockImplementationOnce(async () => started({ password: 'generated-pw-1' }));
    vi.spyOn(ShareHub.prototype, 'list').mockReturnValue([started({})]);
    vi.spyOn(ShareHub.prototype, 'stop').mockResolvedValue([]);
    await routeServer();
    const client = await desktop();
    const file = () => JSON.parse(readFileSync(workspaceShareLinksFile(workspace), 'utf8')).links;

    expect(await client.request('share.start', { workspace, platform: 'ios' })).toMatchObject({
      result: { saved: true, password: 'generated-pw-1' },
    });
    const first = file().ios;
    expect(first).toMatchObject({
      platform: 'ios',
      slot: 'default',
      physical: false,
      token: TOKEN,
      origin: 'https://x.test/s/',
      control: false,
      password: 'generated-pw-1',
      auth: 'generated',
      viewAuth: null,
      state: 'live',
      expiresAt,
    });
    expect(statSync(workspaceShareLinksFile(workspace)).mode & 0o777).toBe(0o600);

    const later = new Date(Date.now() + 7_200_000).toISOString();
    hub.mockImplementationOnce(async () => started({ auth: 'set', expiresAt: later }));
    await client.request('share.start', {
      workspace,
      platform: 'ios',
      token: TOKEN,
      password: 'generated-pw-1',
      expiresAt: later,
    });
    expect(file().ios).toMatchObject({
      auth: 'generated',
      createdAt: first.createdAt,
      expiresAt: later,
      state: 'live',
    });

    await client.request('share.stop', { workspace });
    expect(file().ios.state).toBe('stopped');
  });

  it('marks a share stopped when it ended while its entry was being saved', async () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
    writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
    vi.spyOn(ShareHub.prototype, 'start').mockImplementation(async () => ({
      id: 'w1',
      workspace,
      platform: 'ios',
      slot: 'default',
      physical: false,
      control: false,
      viewers: 0,
      state: 'live',
      auth: 'generated',
      viewAuth: null,
      url: `https://x.test/s/${TOKEN}/`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      password: 'generated-pw-1',
    }));
    vi.spyOn(ShareHub.prototype, 'list').mockReturnValue([]);
    await routeServer();
    const client = await desktop();
    await client.request('share.start', { workspace, platform: 'ios' });
    expect(JSON.parse(readFileSync(workspaceShareLinksFile(workspace), 'utf8')).links.ios.state).toBe('stopped');
  });

  it('refuses setup when Tailscale is unavailable and rejects target parameters', async () => {
    await start();
    const client = await desktop();
    expect(await client.request('route.setup')).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('Start Tailscale') },
    });
    expect(await client.request('route.setup', { port: 443 })).toMatchObject({ error: { code: 'bad-request' } });
  });
});

describe.skipIf(process.platform === 'win32')('Desktop reports', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('shares cached reports and pushes refreshes only to the proved Desktop connection', async () => {
    const build = {
      src: 'builds',
      event: 'build',
      ts: 1000,
      id: 'owned-build',
      startedAt: 500,
      project: root,
      workspace: root,
      branch: null,
      platform: 'ios',
      configuration: 'Debug',
      placement: { where: 'local' },
      cache: { result: 'miss', key: null, fingerprint: null },
      durationMs: 500,
      phases: {},
      outcome: 'succeeded',
      stimVersion: '1',
      level: 'info',
      msg: 'built',
    };
    const cleanup = {
      src: 'gc',
      event: 'gc_item',
      ts: 2000,
      runId: 'owned-cleanup',
      trigger: 'desktop',
      status: 'done',
      kind: 'cache',
      label: 'owned cache',
      id: null,
      path: null,
      bytes: 64,
      detail: null,
      level: 'info',
      msg: 'cleared',
    };
    for (const [path, record] of [
      [buildLedgerFile(), build],
      [gcLogFile(), cleanup],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record)}\n`);
    }
    const port = await start({
      env: { HOME: root, USERPROFILE: root, PATH: dirname(process.execPath), STIM_DAEMON: 'off' },
    });
    const { token } = createPairingToken(Date.now(), capabilitiesFor(true));
    const remote = await connect(port, undefined, { secret: token, keyPair: generateNoiseKeyPair() });
    await remote.request('hello', { client: CLIENT });
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [remote, plain]) {
      for (const report of ['gc-history', 'builds'])
        expect(await client.request('desktop.reports.get', { report })).toHaveProperty('error.code', 'forbidden');
      for (const method of [
        'desktop.reports.get',
        'desktop.reports.subscribe',
        'desktop.reports.invalidate',
        'desktop.doctor.run',
        'desktop.remedy.subscribe',
      ]) {
        expect(
          await client.request(method, method.endsWith('invalidate') ? undefined : { report: 'gc' }),
        ).toHaveProperty('error.code', 'forbidden');
      }
    }
    const client = await desktop();
    const [first, joined] = await Promise.all([
      client.request('desktop.reports.get', { report: 'gc' }),
      client.request('desktop.reports.get', { report: 'gc' }),
    ]);
    assert('result' in first && 'result' in joined);
    expect(first).toMatchObject({
      result: {
        pending: false,
        value: { mode: 'dry-run', sections: expect.any(Object) },
        measuredAt: expect.any(String),
      },
    });
    expect(joined.result).toEqual(first.result);
    for (const [report, record] of [
      ['builds', build],
      ['gc-history', cleanup],
    ] as const)
      expect(await client.request('desktop.reports.get', { report })).toMatchObject({
        result: { pending: false, value: { records: [record] } },
      });
    expect(await client.request('desktop.reports.get', { report: 'remote' })).toMatchObject({
      result: { pending: false, value: { machines: [], findings: [] } },
    });
    const subscribed = await client.request('desktop.reports.subscribe', { report: 'gc' });
    expect(subscribed).toHaveProperty('result.subscription');
    expect(await client.next()).toMatchObject({ event: 'desktop-report', snapshot: first.result });
    expect(await client.request('desktop.reports.invalidate', { report: 'doctor', cwd: root })).toHaveProperty(
      'result',
    );
    expect(await client.request('desktop.reports.invalidate', { report: 'doctor' })).toHaveProperty(
      'error.code',
      'bad-request',
    );
    expect(await client.request('desktop.reports.invalidate', { report: 'gc' })).toHaveProperty('result');
    expect(await client.next()).toMatchObject({ event: 'desktop-report', snapshot: { pending: true } });
    expect(await client.next()).toMatchObject({
      event: 'desktop-report',
      snapshot: { pending: false, value: { mode: 'dry-run' } },
    });
    expect(stimCalls().filter((call) => /^(doctor|gc|logs)\b/.test(call.args))).toEqual([]);
  });

  it('reads an unregistered selected folder without recording a doctor run and rejects ambiguous targets', async () => {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    const config = join(root, 'home', 'config.json');
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    const before = readFileSync(config, 'utf8');
    const client = await desktop();
    for (const params of [
      undefined,
      null,
      { report: 'other' },
      { report: 'doctor', cwd: 'relative' },
      { report: 'gc', cwd: root },
      { report: 'doctor', cwd: root, platform: 'macos' },
      { report: 'doctor', cwd: root, platform: null },
      { report: 'gc', platform: 'ios' },
    ])
      expect(await client.request('desktop.reports.get', params)).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('desktop.reports.get', { report: 'doctor', cwd: root })).toMatchObject({
      result: {
        pending: false,
        value: { project: root, platform: null, findings: expect.any(Array) },
        measuredAt: expect.any(String),
      },
    });
    for (const platform of ['ios', 'android']) {
      const target = { report: 'doctor', cwd: root, platform };
      const result = await client.request('desktop.reports.get', target);
      expect(result).toMatchObject({ result: { pending: false, value: { project: root, platform } } });
      const subscribed = await client.request('desktop.reports.subscribe', target);
      expect(subscribed).toHaveProperty('result.subscription');
      expect(await client.next()).toMatchObject({
        event: 'desktop-report',
        target,
        snapshot: { pending: false, value: { platform } },
      });
      assert('result' in subscribed && subscribed.result !== null && 'subscription' in subscribed.result);
      await client.request('unsubscribe', { subscription: subscribed.result.subscription });
    }
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(stimCalls()).toEqual([]);
  });

  it('records an explicit project check after a read-only report without spawning a CLI', async () => {
    const selected = join(root, 'selected');
    mkdirSync(selected);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    const config = join(root, 'home', 'config.json');
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    const before = readFileSync(config, 'utf8');
    const client = await desktop();
    expect(
      await client.request('desktop.reports.get', { report: 'doctor', cwd: selected, platform: 'ios' }),
    ).toMatchObject({
      result: { value: { project: selected, platform: 'ios' } },
    });
    expect(readFileSync(config, 'utf8')).toBe(before);
    for (const params of [
      undefined,
      {},
      { cwd: 'relative' },
      { cwd: selected, platform: 'web' },
      { cwd: selected, fix: true },
    ]) {
      expect(await client.request('desktop.doctor.run', params)).toHaveProperty('error.code', 'bad-request');
    }
    const started = Date.now();
    expect(await client.request('desktop.doctor.run', { cwd: selected, platform: 'ios' })).toMatchObject({
      result: { project: selected, platform: 'ios', findings: expect.any(Array) },
    });
    const recorded = JSON.parse(readFileSync(config, 'utf8')).projects[selected].doctorRuns;
    expect(Object.keys(recorded)).toEqual(['ios']);
    expect(recorded.ios.version).toBe(
      JSON.parse(readFileSync(new URL('../../stim-cli/package.json', import.meta.url), 'utf8')).version,
    );
    expect(Date.parse(recorded.ios.at)).toBeGreaterThanOrEqual(started);
    expect(stimCalls()).toEqual([]);
  });

  it.each(['acquisition', 'cleanup', 'claims-and-cleanup'] as const)(
    'admits a remedy retry only after its %s refusal is resolved',
    async (mode) => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
      const claim =
        mode === 'claims-and-cleanup' ? tryAcquireClaim({ root: join(root, 'remedy-claim'), mode: 'exclusive' }) : null;
      if (claim && !claim.acquired) throw new Error('The fixture claim was not acquired');
      const held = claim?.acquired;
      let recovered = false;
      let first = true;
      const original = stimSelf.createStim;
      const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => {
        const client = original(options);
        return {
          ...client,
          unlockDevice: async (request) => {
            if (!first) return client.unlockDevice(request);
            first = false;
            const cause =
              mode === 'acquisition'
                ? new ClaimUnavailableError('fixture claim store is not writable')
                : Object.assign(new Error('Fixture report cleanup is unresolved.'), {
                    reportCleanup: true,
                    cleanupSettled: () => recovered,
                  });
            throw new stim.StimError(
              {
                code: 'STIM_CLAIM_UNAVAILABLE',
                message: cause.message,
                ...(held ? { details: { cause: { retainedClaimRoots: [held.root] } } } : {}),
              },
              { cause },
            );
          },
        };
      });
      try {
        await start();
        const client = await desktop();
        const request = () =>
          client.request('desktop.remedy.subscribe', { cwd: workspace, action: 'device-unlock', platform: 'ios' });
        const ended = async () => {
          for (;;) {
            const event = await client.next();
            if ('event' in event && event.event === 'desktop-remedy-ended') return event;
          }
        };
        expect(await request()).toHaveProperty('result.subscription');
        expect(await ended()).toMatchObject({ exitCode: 1 });
        const refusals: unknown[] = [];
        if (mode !== 'acquisition') {
          refusals.push(await request());
          if (held) {
            releaseClaim(held);
            refusals.push(await request());
          }
          recovered = true;
        }
        expect(refusals).toEqual(
          Array.from({ length: mode === 'acquisition' ? 0 : held ? 2 : 1 }, () =>
            expect.objectContaining({ error: expect.objectContaining({ code: 'action-busy' }) }),
          ),
        );
        expect(await request()).toHaveProperty('result.subscription');
        expect(await ended()).toMatchObject({ exitCode: 0 });
      } finally {
        api.mockRestore();
        releaseClaim(held);
      }
    },
  );

  it('runs private typed remedies without a CLI and rejects unsupported scopes', async () => {
    const selected = join(root, 'selected');
    mkdirSync(selected);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    const client = await desktop();
    for (const params of [
      undefined,
      {},
      { cwd: selected, action: 'other' },
      { cwd: 'relative', action: 'doctor-fix' },
      { cwd: selected, action: 'doctor-fix', slot: 'default' },
      { cwd: selected, action: 'device-unlock', slot: '__proto__' },
      { cwd: selected, action: 'device-unlock', platform: 'web' },
      { cwd: selected, action: 'device-tool', request: { tool: 'exec', platform: 'ios', args: ['rm'] } },
      { cwd: selected, action: 'device-tool', request: { tool: 'push', platform: 'android', payload: '{"aps":{}}' } },
      { cwd: selected, action: 'device-tool', request: { tool: 'location', platform: 'ios', clear: true, set: '1,2' } },
      {
        cwd: selected,
        action: 'device-tool',
        request: { tool: 'network', platform: 'android', state: 'off', args: [] },
      },
      {
        cwd: selected,
        action: 'device-tool',
        request: { tool: 'location', platform: 'ios', clear: true },
        slot: '__proto__',
      },
    ])
      expect(await client.request('desktop.remedy.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    const expected = {
      'doctor-fix': expect.objectContaining({ project: selected, platform: 'ios', findings: expect.any(Array) }),
      'device-unlock': [],
    };
    for (const action of ['doctor-fix', 'device-unlock'] as const) {
      const subscribed = await client.request('desktop.remedy.subscribe', { cwd: selected, action, platform: 'ios' });
      expect(subscribed).toHaveProperty('result.subscription');
      let ended;
      for (;;) {
        const event = await client.next();
        if ('event' in event && event.event === 'desktop-remedy-ended') {
          ended = event;
          break;
        }
      }
      expect(ended).toMatchObject({ event: 'desktop-remedy-ended', exitCode: 0 });
      assert('stdout' in ended && typeof ended.stdout === 'string');
      const output = JSON.parse(ended.stdout);
      expect(output).toEqual(expected[action]);
    }
    expect(
      await client.request('desktop.remedy.subscribe', {
        cwd: selected,
        action: 'device-tool',
        request: { tool: 'location', platform: 'ios', clear: true },
      }),
    ).toHaveProperty('result.subscription');
    let toolEnded;
    for (;;) {
      const event = await client.next();
      if ('event' in event && event.event === 'desktop-remedy-ended') {
        toolEnded = event;
        break;
      }
    }
    expect(toolEnded).toMatchObject({ exitCode: 1 });
    assert('stdout' in toolEnded && typeof toolEnded.stdout === 'string');
    expect(JSON.parse(toolEnded.stdout)).toMatchObject({ code: 'STIM_DEVICE_TOOL_TARGET', remedy: expect.any(String) });
    expect(stimCalls()).toEqual([]);
    const config = JSON.parse(readFileSync(join(root, 'home', 'config.json'), 'utf8'));
    expect(config.projects[selected].doctorRuns.ios.at).toEqual(expect.any(String));
  });

  it.each(['CMake safety', 'repository lookup'])(
    'keeps other Desktop requests responsive during real delayed repair %s',
    async (stage) => {
      const selected = join(root, 'repair-selected');
      const tools = join(root, 'repair-tools');
      const ready = join(root, 'repair-git-pid');
      const target = join(selected, 'android/app/.cxx/Debug/fixture/arm64-v8a');
      mkdirSync(target, { recursive: true });
      mkdirSync(tools);
      writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
      writeFileSync(join(selected, '.gitignore'), '.cxx/\n');
      writeFileSync(
        join(target, 'CMakeCache.txt'),
        'CMAKE_BUILD_TYPE:STRING=Debug\nCMAKE_CXX_COMPILER_LAUNCHER:STRING=\n',
      );
      execFileSync('/usr/bin/git', ['init', '-q', selected]);
      writeFileSync(join(tools, 'ccache'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(
        join(tools, 'git'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const repositoryLookup = args.includes('rev-parse') && args.includes('--show-toplevel') && process.cwd() === ${JSON.stringify(selected)};
const counter = ${JSON.stringify(join(root, 'repair-root-lookups'))};
const lookups = repositoryLookup ? (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1 : 0;
if (repositoryLookup) fs.writeFileSync(counter, String(lookups));
const delayed = ${JSON.stringify(stage)} === 'repository lookup'
  ? repositoryLookup && lookups > 1
  : args.includes('ls-files') && args.some(arg => arg.startsWith(':(literal)'));
if (delayed) {
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  setTimeout(() => process.exit(2), 15000);
} else {
  const child = cp.spawn('/usr/bin/git', args, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
}
`,
        { mode: 0o755 },
      );
      await start({
        env: {
          HOME: root,
          USERPROFILE: root,
          PATH: [tools, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
          STIM_DAEMON: 'off',
        },
      });
      const client = await desktop();
      const subscribed = await client.request('desktop.remedy.subscribe', {
        cwd: selected,
        action: 'doctor-fix',
        platform: stage === 'CMake safety' ? 'android' : 'ios',
      });
      assert('result' in subscribed && subscribed.result !== null && 'subscription' in subscribed.result);
      const pid = await waitForPid(ready, 4000);
      const processToken = captureProcessToken(pid);
      assert(processToken);
      const record = { pid, processToken };
      expect(await client.request('desktop.settings.schema')).toMatchObject({
        result: { properties: expect.any(Object) },
      });
      expect(inspectProcessIdentity(record)).toBe('same');
      expect(await client.request('unsubscribe', { subscription: subscribed.result.subscription })).toHaveProperty(
        'result',
      );
      expect(inspectProcessIdentity(record)).toMatch(/^(gone|different)$/);
      expect(existsSync(join(target, 'CMakeCache.txt'))).toBe(true);
      expect(await client.request('desktop.settings.schema')).toHaveProperty('result');
    },
  );

  it.each([
    { timing: 'within budget', directory: 'project root' },
    { timing: 'past cleanup budget', directory: 'project root' },
    { timing: 'within budget', directory: 'project subdirectory' },
    { timing: 'past cleanup budget', directory: 'project subdirectory' },
  ])('holds admission for an in-flight repair deletion ($timing, $directory)', async ({ timing, directory }) => {
    const selected = join(root, 'deletion-selected');
    const tools = join(root, 'deletion-tools');
    const requested = directory === 'project subdirectory' ? join(selected, 'src') : selected;
    mkdirSync(requested, { recursive: true });
    const target = join(selected, 'android/app/.cxx/Debug/fixture/arm64-v8a');
    mkdirSync(target, { recursive: true });
    mkdirSync(tools);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    writeFileSync(join(selected, '.gitignore'), '.cxx/\n');
    writeFileSync(
      join(target, 'CMakeCache.txt'),
      'CMAKE_BUILD_TYPE:STRING=Debug\nCMAKE_CXX_COMPILER_LAUNCHER:STRING=\n',
    );
    execFileSync('/usr/bin/git', ['init', '-q', selected]);
    writeFileSync(join(tools, 'ccache'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [tools, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    const client = await desktop();
    const other = await desktop();
    let deleting = false;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = fsPromises.rm;
    const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === target) {
        deleting = true;
        await blocked;
      }
      return remove(path, options);
    });
    syncBuiltinESMExports();
    let cancelled: Promise<ServerMessage> | undefined;
    let acknowledged = false;
    try {
      const subscribed = await client.request('desktop.remedy.subscribe', {
        cwd: requested,
        action: 'doctor-fix',
        platform: 'android',
      });
      assert('result' in subscribed && subscribed.result !== null && 'subscription' in subscribed.result);
      await vi.waitFor(() => expect(deleting).toBe(true));
      if (timing === 'past cleanup budget') vi.useFakeTimers();
      cancelled = client.request('unsubscribe', { subscription: subscribed.result.subscription }).then((result) => {
        acknowledged = true;
        return result;
      });
      expect(await other.request('desktop.settings.schema')).toHaveProperty('result');
      expect(acknowledged).toBe(false);
      expect(
        await other.request('desktop.build.subscribe', {
          cwd: selected,
          options: { platform: 'macos', remoteBuild: 'local' },
        }),
      ).toHaveProperty('error.code', 'action-busy');
      if (timing === 'past cleanup budget') {
        await vi.waitFor(() => assert(vi.getTimerCount() > 0));
        await vi.advanceTimersByTimeAsync(35_000);
        const failure = await cancelled;
        assert('error' in failure && failure.error.code === 'action-failed');
        const blockedBuild = await other.request('desktop.build.subscribe', {
          cwd: selected,
          options: { platform: 'macos', remoteBuild: 'local' },
        });
        assert('error' in blockedBuild && blockedBuild.error.code === 'action-busy');
        const refused = await other.request('desktop.remedy.subscribe', {
          cwd: selected,
          action: 'device-unlock',
          platform: 'ios',
        });
        assert('error' in refused && refused.error.code === 'action-busy');
        release();
        vi.useRealTimers();
        let retried: ServerMessage | undefined;
        await vi.waitFor(async () => {
          retried = await other.request('desktop.remedy.subscribe', {
            cwd: selected,
            action: 'device-unlock',
            platform: 'ios',
          });
          assert('result' in retried && retried.result !== null && 'subscription' in retried.result);
        });
        assert(retried && 'result' in retried && retried.result !== null && 'subscription' in retried.result);
        for (;;) {
          const event = await other.next();
          if ('event' in event && event.event === 'desktop-remedy-ended') {
            assert.equal(event.exitCode, 0);
            break;
          }
        }
      } else {
        release();
        assert('result' in (await cancelled));
      }
      expect(existsSync(target)).toBe(false);
      expect(await client.request('desktop.settings.schema')).toHaveProperty('result');
    } finally {
      release();
      vi.useRealTimers();
      await cancelled;
      deletion.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('applies the report byte quota to both get and pushed errors', async () => {
    await start({
      commandLimits: { maxOutputBytes: 1 },
      env: { HOME: root, USERPROFILE: root, PATH: dirname(process.execPath), STIM_DAEMON: 'off' },
    });
    const client = await desktop();
    expect(await client.request('desktop.reports.get', { report: 'gc' })).toMatchObject({
      error: { code: 'stim-failed', message: 'stim gc printed more than 1 bytes.' },
    });
    await client.request('desktop.reports.subscribe', { report: 'gc' });
    expect(await client.next()).toMatchObject({
      event: 'desktop-report',
      snapshot: { pending: false, value: null, error: 'stim gc printed more than 1 bytes.' },
    });
  });

  it('serves five identical waiting reports from one load', async () => {
    const bin = join(root, 'bin');
    const jobs = join(root, 'report-git-jobs');
    const release = join(root, 'release');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
writeFileSync(require('node:path').join(process.env.REPORT_GIT_JOBS, String(process.pid)), '');
const timer = setInterval(() => {
  if (existsSync(process.env.REPORT_RELEASE)) {
    clearInterval(timer);
    process.exit(1);
  }
}, 20);
`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: bin + ':' + process.env.PATH,
        REPORT_GIT_JOBS: jobs,
        REPORT_RELEASE: release,
        STIM_DAEMON: 'off',
      },
    });
    const client = await desktop();
    const target = { report: 'doctor', cwd: workspace };
    const replies = Promise.all(Array.from({ length: 5 }, () => client.request('desktop.reports.get', target)));
    await until(() => readdirSync(jobs).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(jobs)).toHaveLength(2);
    writeFileSync(release, '');
    const results = await replies;
    expect(results.every((reply) => 'result' in reply)).toBe(true);
    expect(new Set(results.map((reply) => ('result' in reply ? JSON.stringify(reply.result) : null))).size).toBe(1);
    expect(results[0]).toMatchObject({ result: { pending: false, value: { project: workspace } } });
  });

  it('answers interactive requests while reports wait, caps report waiters, and drains shared probes at shutdown', async () => {
    const bin = join(root, 'bin');
    const jobs = join(root, 'report-git-jobs');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}
require('node:fs').writeFileSync(require('node:path').join(process.env.REPORT_GIT_JOBS, String(process.pid)), '');
require('node:net').createServer().listen(0, '127.0.0.1');
`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const processes = () => readdirSync(jobs).map(Number);
    await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: bin + ':' + process.env.PATH,
        REPORT_GIT_JOBS: jobs,
        STIM_DAEMON: 'off',
      },
    });
    const first = await desktop();
    const second = await desktop();
    for (let id = 100; id < 117; id++)
      first.socket.send(
        JSON.stringify({ id, method: 'desktop.reports.get', params: { report: 'doctor', cwd: workspace } }),
      );
    expect(await first.next()).toMatchObject({
      id: 116,
      error: { code: 'limit-exceeded', message: 'A connection can wait for 16 reports at a time.' },
    });
    await until(() => processes().length === 2);
    expect(await first.request('stats.get')).toHaveProperty('result');
    await second.request('desktop.reports.subscribe', { report: 'doctor', cwd: workspace });
    expect(await second.next()).toMatchObject({ event: 'desktop-report', snapshot: { pending: true } });
    first.socket.close();
    await first.closed;
    expect(processes()).toHaveLength(2);
    expect(processes().every(alive)).toBe(true);
    assert(server);
    await server.close();
    forgetServer();
    expect(processes()).toHaveLength(2);
    expect(processes().every((pid) => !alive(pid))).toBe(true);
  });
});

describe('setup approval in Stim Desktop on this machine', () => {
  const never = async (): Promise<never> => {
    throw new Error('Desktop-approved setup must not install or change a service');
  };
  /** The machine-facing parts of setup are fakes; the ticket, claim, secret, records and journal are the real ones. */
  const setupDeps = (): SetupDeps => ({
    platform: 'darwin',
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    tty: false,
    stdout: () => {},
    stderr: () => {},
    confirm: never,
    permissionWait: never,
    preflight: async () => ({ dnsName: 'worker.ts.net' }),
    fingerprint: () => 'worker-fingerprint',
    firewall: async () => null,
    claim: setupClaim,
    write: writeSetupJournal,
    prune: pruneSetupJournals,
    withInstallClaim: (_label, work) => work(),
    installed: async () => null,
    health: async (port) => {
      const health = await fetchHealth(port);
      return (
        health && {
          ...health,
          host: {
            name: 'Stim Desktop',
            screenRecording: false,
            accessibility: false,
          },
        }
      );
    },
    build: () => ({ version: '1.2.3', stimBuild: 'digest' }),
    install: never,
    select: never,
    installHost: async () => ({
      app: '/Stim Host.app',
      executable: '/Stim Host.app/Contents/MacOS/stim-host',
      name: 'Stim Host',
      bundleId: 'dev.stim.host',
      replaced: false,
      adHoc: false,
    }),
    installJob: never,
    route: async () => ({ state: 'routed', port: 7443 }),
    prepareRoute: async () => ({
      record: { port: 7443, created: false },
      create: null,
    }),
    recordRoute: async () => {},
    createRoute: never,
    records: () => [...readBuildClients(), ...readDeviceHostClients()],
    watchRecords: watchClientRegistries,
    storeSecret: storeSetupSecret,
    dropSecret: dropSetupSecret,
    panes: async () => ({
      screen: 'Screen & System Audio Recording',
      control: 'Accessibility',
    }),
    requestPermissions: never,
    openPane: async () => {},
    toolchain: async () => ({
      stimBuild: 'digest',
      arch: 'arm64',
      xcode: '27',
      simulatorSdk: '27',
      macosSdk: '27',
      cocoapods: '1.16',
      runtimes: ['iOS-27'],
      jdk: '17',
      androidSdk: { ndk: ['27'], buildTools: ['36'], platforms: ['36'] },
    }),
    node: process.execPath,
    versions: () => root,
    stimBuild: 'digest',
  });

  type SetupEvent = Extract<ServerMessage, { event: 'desktop-setup-progress' | 'desktop-setup-ended' }>;

  async function nextSetup(client: Client, check: (event: SetupEvent) => boolean): Promise<SetupEvent> {
    for (;;) {
      const message = await client.next();
      if (
        'event' in message &&
        (message.event === 'desktop-setup-progress' || message.event === 'desktop-setup-ended') &&
        check(message)
      )
        return message;
    }
  }

  const asking = (capability: string) => (event: SetupEvent) =>
    event.event === 'desktop-setup-progress' && event.asking === capability;
  const step = (prefix: string) => (event: SetupEvent) =>
    event.event === 'desktop-setup-progress' &&
    event.journal.steps.some((each) => each.state === 'running' && each.id.startsWith(prefix));
  const waitsForMachine = (event: SetupEvent) =>
    event.event === 'desktop-setup-progress' &&
    event.journal.steps.some(
      (each) =>
        each.id === 'approve' && each.state === 'running' && each.detail?.startsWith('Waiting for the requesting'),
    );
  const ended = (event: SetupEvent) => event.event === 'desktop-setup-ended';

  function request(capabilities: string[] = ['build'], minutes = 30) {
    const ticket = newSecret();
    const values = secretValues(Buffer.from(ticket, 'base64url'));
    return {
      ticket,
      journal: values.journal,
      stored: () => secretPsk(values.lookup.toString('hex')) !== null,
      params: {
        ticket,
        expires: new Date(Date.now() + minutes * 60_000).toISOString(),
        capabilities,
      },
    };
  }

  it('refuses every connection but the proved local Desktop and stores nothing', async () => {
    const port = await start({ setupDeps });
    const asked = request();
    const peer = await pair(port, '100.64.0.2', true);
    const remote = await returning(port, peer.keyPair, '100.64.0.2');
    const loopbackPairing = await authed(port, true);
    const build = await returning(port, setupClient(['build']).keyPair, '100.64.0.3', 'build');
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [remote, loopbackPairing, build, plain]) {
      expect(await client.request('desktop.setup.subscribe', asked.params)).toHaveProperty('error.code', 'forbidden');
      expect(
        await client.request('desktop.setup.answer', {
          journal: asked.journal,
          answer: 'approve',
          capability: 'build',
        }),
      ).toHaveProperty('error.code', 'forbidden');
    }
    expect(asked.stored()).toBe(false);
    expect(readSetupJournal(asked.journal)).toBeNull();
  });

  it('is not offered on a server Desktop did not start', async () => {
    await start({ setupDeps, desktopBootstrap: null });
    assert(server);
    const client = await localConnect(server);
    await client.request('hello', { client: CLIENT });
    const asked = request();
    expect(await client.request('desktop.setup.subscribe', asked.params)).toHaveProperty('error.code', 'forbidden');
    expect(asked.stored()).toBe(false);
  });

  it('stores the ticket only for the grants the person approves, which the requesting machine then spends', async () => {
    const port = await start({ setupDeps });
    const desktopClient = await desktop();
    const asked = request(['build', 'device-host']);
    expect(await desktopClient.request('desktop.setup.subscribe', asked.params)).toHaveProperty('result.subscription');
    expect(await desktopClient.request('desktop.setup.subscribe', asked.params)).toHaveProperty(
      'error.code',
      'bad-request',
    );
    await nextSetup(desktopClient, asking('build'));
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: asked.journal,
        answer: 'approve',
        capability: 'device-host',
      }),
    ).toHaveProperty('error.code', 'bad-request');
    expect(asked.stored()).toBe(false);
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: asked.journal,
        answer: 'approve',
        capability: 'build',
      }),
    ).toEqual(expect.objectContaining({ result: {} }));
    await nextSetup(desktopClient, asking('device-host'));
    expect(asked.stored()).toBe(false);
    await desktopClient.request('desktop.setup.answer', {
      journal: asked.journal,
      answer: 'refuse',
      capability: 'device-host',
    });
    await nextSetup(desktopClient, waitsForMachine);
    expect(asked.stored()).toBe(true);

    const keyPair = generateNoiseKeyPair();
    const requester = await connect(port, '100.64.0.2', {
      secret: asked.ticket,
      keyPair,
      name: 'Laptop',
    });
    expect(await requester.request('hello', { client: CLIENT, access: 'build' })).toHaveProperty(
      'result.capabilities',
      ['build'],
    );
    await nextSetup(desktopClient, step('permissions.screenRecording'));
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: asked.journal,
        answer: 'skip',
        permission: 'deviceControl',
      }),
    ).toHaveProperty('error.code', 'bad-request');
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: asked.journal,
        answer: 'skip',
        permission: 'screenRecording',
      }),
    ).toEqual(expect.objectContaining({ result: {} }));
    await nextSetup(desktopClient, step('permissions.deviceControl'));
    await desktopClient.request('desktop.setup.answer', {
      journal: asked.journal,
      answer: 'skip',
      permission: 'deviceControl',
    });
    const end = await nextSetup(desktopClient, ended);
    expect(end).toMatchObject({ exitCode: 1, output: { granted: [{ capability: 'build' }] } });
    expect(readBuildClients()).toEqual([
      expect.objectContaining({
        name: 'Laptop',
        publicKey: keyPair.publicKey.toString('base64url'),
      }),
    ]);
    expect(readDeviceHostClients()).toEqual([]);
    expect(readFileSync(join(root, 'home', 'server', 'secrets.json'), 'utf8')).not.toContain(asked.ticket);
  });

  it('stores nothing when the person refuses every grant', async () => {
    const port = await start({ setupDeps });
    const desktopClient = await desktop();
    const asked = request();
    await desktopClient.request('desktop.setup.subscribe', asked.params);
    await nextSetup(desktopClient, asking('build'));
    await desktopClient.request('desktop.setup.answer', {
      journal: asked.journal,
      answer: 'refuse',
      capability: 'build',
    });
    const end = await nextSetup(desktopClient, ended);
    expect(end).toMatchObject({ exitCode: 1, output: { granted: [] } });
    expect(asked.stored()).toBe(false);
    await expect(connect(port, '100.64.0.2', { secret: asked.ticket })).rejects.toMatchObject({
      code: 'unknown-secret',
    });
  });

  it("applies setup's own ticket rules and takes one request at a time", async () => {
    await start({ setupDeps });
    const desktopClient = await desktop();
    for (const params of [request(['build'], 3 * 60).params, request(['build'], -1).params]) {
      expect(await desktopClient.request('desktop.setup.subscribe', params)).toHaveProperty(
        'error.code',
        'bad-request',
      );
    }
    const first = request();
    await desktopClient.request('desktop.setup.subscribe', first.params);
    await nextSetup(desktopClient, asking('build'));
    const second = request();
    await desktopClient.request('desktop.setup.subscribe', second.params);
    const refused = await nextSetup(desktopClient, ended);
    expect(refused).toMatchObject({
      exitCode: 1,
      output: { warnings: expect.arrayContaining([expect.stringContaining('Another setup holds')]) },
    });
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: second.journal,
        answer: 'approve',
        capability: 'build',
      }),
    ).toHaveProperty('error.code', 'bad-request');
    expect(
      await desktopClient.request('desktop.setup.answer', {
        journal: first.journal,
        answer: 'skip',
        permission: 'screenRecording',
      }),
    ).toHaveProperty('error.code', 'bad-request');
    await desktopClient.request('desktop.setup.answer', {
      journal: first.journal,
      answer: 'refuse',
      capability: 'build',
    });
    await nextSetup(desktopClient, ended);
    expect(second.stored()).toBe(false);
  });

  it('withdraws an approved ticket when Desktop closes the request before the machine connects', async () => {
    const port = await start({ setupDeps });
    const desktopClient = await desktop();
    const asked = request();
    expect(await desktopClient.request('desktop.setup.subscribe', asked.params)).toHaveProperty(
      'result.subscription',
      's1',
    );
    await nextSetup(desktopClient, asking('build'));
    await desktopClient.request('desktop.setup.answer', {
      journal: asked.journal,
      answer: 'approve',
      capability: 'build',
    });
    await nextSetup(desktopClient, waitsForMachine);
    expect(asked.stored()).toBe(true);
    expect(await desktopClient.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
    await vi.waitFor(() => expect(asked.stored()).toBe(false));
    await expect(connect(port, '100.64.0.2', { secret: asked.ticket })).rejects.toMatchObject({
      code: 'unknown-secret',
    });
  });
  it('refuses on a machine with a stim-server service installed instead of installing or changing it', async () => {
    const service: InstalledService = {
      label: 'dev.stim.server',
      host: null,
      node: '/node',
      script: '/server.mjs',
      port: 0,
      env: [],
      pathPrepend: [],
      stimHome: root,
      logPath: '/log',
      managed: true,
      serve: null,
      previousScript: null,
      programArguments: [],
    };
    let port = 0;
    port = await start({ setupDeps: () => ({ ...setupDeps(), installed: async () => ({ ...service, port }) }) });
    const desktopClient = await desktop();
    const asked = request();
    await desktopClient.request('desktop.setup.subscribe', asked.params);
    const end = await nextSetup(desktopClient, (event) => ended(event) || asking('build')(event));
    expect(end).toMatchObject({
      event: 'desktop-setup-ended',
      exitCode: 1,
      output: { warnings: expect.arrayContaining([expect.stringContaining('is installed on this machine')]) },
    });
    expect(asked.stored()).toBe(false);
  });
});

describe('stats.get and settings.get', () => {
  it('read stats and settings without running the CLI, settings in the home directory by default', async () => {
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), archive: { maxCount: 7 } }));
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toEqual({
      id: 2,
      result: readStatsReport(null, Date.now()).report,
    });
    expect(await client.request('settings.get')).toMatchObject({
      id: 3,
      result: {
        project: null,
        files: { machine: config },
        settings: expect.arrayContaining([
          { key: 'archive.maxCount', value: 7, origin: 'machine', layers: { machine: 7 } },
        ]),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reads settings with the server environment and reports a refusal with its code and remedy', async () => {
    const port = await start({ env: { STIM_DISK_MIN_FREE_GB: 'lots' } });
    const client = await authed(port);
    expect(await client.request('settings.get', { workspace })).toMatchObject({
      error: {
        code: 'stim-failed',
        message: expect.stringMatching(
          /^STIM_BAD_ARG: Invalid STIM_DISK_MIN_FREE_GB value "lots"\. Expected a number, 0 or more\. Fix the environment variable/,
        ),
      },
    });
  });

  it('preserves seeded stats, rejects unregistered paths, and never repairs unreadable versions', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const file = join(process.env.STIM_HOME!, 'stats.json');
    const projectKey = realpathSync.native(workspace);
    const content = JSON.stringify({
      version: 1,
      machine: { ios: { runs: '3', hits: 2 } },
      projects: {
        [projectKey]: { android: { runs: 1, lastColdBuildMs: 1234 } },
      },
    });
    writeFileSync(file, content);
    const port = await start();
    const client = await authed(port);
    expect(await client.request('stats.get', { workspace })).toMatchObject({
      result: {
        version: 1,
        project: { key: projectKey, ios: null, android: { runs: 1, lastColdBuildMs: 1234 } },
        machine: { ios: { runs: 3, hits: 2 }, android: null },
      },
    });
    expect(readFileSync(file, 'utf8')).toBe(content);
    for (const invalid of [null, [], 'workspace']) {
      expect(await client.request('stats.get', invalid)).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(await client.request('stats.get', { workspace: root })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const text of ['{broken', '{"version":999}']) {
      writeFileSync(file, text);
      expect(await client.request('stats.get', { workspace })).toMatchObject({
        result: {
          project: { key: projectKey, ios: null, android: null },
          machine: { ios: null, android: null },
        },
      });
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(readdirSync(process.env.STIM_HOME!).filter((name) => name.startsWith('stats'))).toEqual(['stats.json']);
    }
    expect(stimCalls()).toEqual([]);
  });

  it('bounds stats output and releases the request slot after refusal', async () => {
    const file = join(process.env.STIM_HOME!, 'stats.json');
    writeFileSync(file, JSON.stringify({ version: 1, buildMachines: { ['x'.repeat(2048)]: {} } }));
    const port = await start({ commandLimits: { maxOutputBytes: 1024 } });
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({
      error: { code: 'stim-failed', message: 'stim stats printed more than 1024 bytes.' },
    });
    rmSync(file);
    expect(await client.request('stats.get')).toMatchObject({ result: { version: 1 } });
  });

  it('serves both stats consumers when the CLI entry is unavailable', async () => {
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    rmSync(join(root, 'fake-stim.mjs'));
    const client = await authed(port);
    expect(await client.request('stats.get')).toMatchObject({ result: { version: 1 } });
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: expect.objectContaining({ mode: 'dry-run', sections: expect.any(Object) }),
        stats: { version: 1 },
      },
    });
  });

  it('force-kills an unresponsive read child and settles cancellation', async () => {
    const entry = join(root, 'blocked-read.mjs');
    const ready = join(root, 'blocked-read.pid');
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.READ_PID, String(process.pid));
while (true) {}
`,
    );
    const run = runNodeCommand(
      entry,
      { ...process.env, READ_PID: ready },
      [],
      root,
      { timeoutMs: 10_000, maxOutputBytes: 1024 },
      'stats fixture',
      true,
    );
    try {
      let pid = 0;
      await until(() => {
        if (!existsSync(ready)) return false;
        pid = Number(readFileSync(ready, 'utf8'));
        return Number.isSafeInteger(pid) && pid > 0;
      });
      await run.cancel();
      expect(alive(pid)).toBe(false);
    } finally {
      await run.cancel();
    }
  });

  function slowGit(): { env: Record<string, string>; processes: (command?: string) => number[] } {
    const bin = join(root, 'bin');
    const jobs = join(root, 'git-jobs');
    mkdirSync(bin);
    mkdirSync(jobs);
    writeFileSync(join(workspace, 'package.json'), '{}');
    const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const pending = path.join(process.env.STATS_GIT_JOBS, '..', 'git-' + process.pid);
fs.writeFileSync(pending, JSON.stringify(process.argv.slice(2)));
fs.renameSync(pending, path.join(process.env.STATS_GIT_JOBS, String(process.pid)));
require('node:net').createServer().listen(0, '127.0.0.1');
`;
    writeFileSync(join(bin, 'git'), script);
    chmodSync(join(bin, 'git'), 0o755);
    return {
      env: { PATH: bin + ':' + process.env.PATH, STATS_GIT_JOBS: jobs },
      processes: (command) =>
        readdirSync(jobs)
          .filter((pid) => !command || JSON.parse(readFileSync(join(jobs, pid), 'utf8')).includes(command))
          .map(Number),
    };
  }

  describe.skipIf(process.platform === 'win32')('plan cleanup', () => {
    test.each(['timeout', 'disconnect', 'shutdown'] as const)(
      'reaps real in-process plan Git children on %s while another socket stays responsive',
      async (mode) => {
        const slow = slowGit();
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
        const port = await start({ env: slow.env, commandLimits: { timeoutMs: mode === 'timeout' ? 1000 : 10000 } });
        const client = await authed(port),
          other = await authed(port);
        const reply = client.request('build.plan', { workspace, platform: 'ios' });
        await until(() => slow.processes().length > 0);
        expect(await other.request('machine.history')).toHaveProperty('result');
        if (mode === 'disconnect') client.socket.terminate();
        else if (mode === 'shutdown') {
          assert(server);
          await server.close();
          forgetServer();
        }
        const response = mode === 'timeout' ? await reply : null;
        const failure = response && 'error' in response ? response.error : null;
        expect(failure).toEqual(
          mode === 'timeout' ? { code: 'stim-failed', message: 'stim ios did not finish within 1 s.' } : null,
        );
        await until(() => slow.processes().every((pid) => !alive(pid)));
        expect(stimCalls()).toEqual([]);
      },
    );
  });

  test.skipIf(process.platform === 'win32')(
    'keeps another socket responsive, shares the command cap, and cancels stats plus its Git child on disconnect',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, requestLimits: { connection: 4 } });
      const first = await authed(port);
      const second = await authed(port);
      for (let id = 10; id < 14; id++)
        first.socket.send(JSON.stringify({ id, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length >= 4);
      expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(await first.request('settings.get')).toMatchObject({ error: { code: 'limit-exceeded' } });
      const owned = slow.processes();
      first.socket.terminate();
      await until(() => owned.every((pid) => !alive(pid)));
      expect(await second.request('stats.get')).toMatchObject({ result: { version: 1 } });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'bounds a tailnet device across its connections until its cancelled reads drain',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, requestLimits: { device: 2 } });
      const peer = '100.64.0.2';
      const { keyPair } = await pair(port, peer);
      const first = await returning(port, keyPair, peer);
      const second = await returning(port, keyPair, peer);
      for (let id = 10; id < 12; id++)
        first.socket.send(JSON.stringify({ id, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length >= 2);
      expect(await second.request('stats.get', { workspace })).toMatchObject({
        error: { code: 'limit-exceeded', message: 'A remote device can run 2 requests at a time.' },
      });
      const owned = slow.processes();
      first.socket.terminate();
      await until(() => owned.every((pid) => !alive(pid)));
      second.socket.send(JSON.stringify({ id: 20, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length > owned.length);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'cancels a slow stats read and its Git child at timeout and server shutdown',
    async () => {
      const slow = slowGit();
      const port = await start({ env: slow.env, commandLimits: { timeoutMs: 1000 } });
      const client = await authed(port);
      const reply = client.request('stats.get', { workspace });
      await until(() => slow.processes().length === 2);
      expect(await reply).toMatchObject({
        error: { code: 'stim-failed', message: 'stim stats did not finish within 1 s.' },
      });
      await until(() => slow.processes().every((pid) => !alive(pid)));
      client.socket.send(JSON.stringify({ id: 10, method: 'stats.get', params: { workspace } }));
      await until(() => slow.processes().length === 4);
      await server!.close();
      forgetServer();
      expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'reads settings in-process, keeping another socket responsive and killing its Git children at timeout and on disconnect',
    async () => {
      const slow = slowGit();
      const gits = slow.processes;
      const port = await start({ env: slow.env, commandLimits: { timeoutMs: 1000 } });
      const first = await authed(port);
      const second = await authed(port);
      const reply = first.request('settings.get', { workspace });
      await until(() => gits().length > 0);
      expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(await reply).toMatchObject({
        error: { code: 'stim-failed', message: 'stim settings did not finish within 1 s.' },
      });
      await until(() => gits().every((pid) => !alive(pid)));
      const timedOut = gits().length;
      first.socket.send(JSON.stringify({ id: 20, method: 'settings.get', params: { workspace } }));
      await until(() => gits().length > timedOut);
      first.socket.terminate();
      await until(() => gits().every((pid) => !alive(pid)));
      expect(stimCalls()).toEqual([]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps the shared details stats job after a socket closes and cancels it on server close',
    async () => {
      const slow = slowGit();
      const previous = process.env.HOME;
      process.env.HOME = root;
      writeFileSync(join(root, 'package.json'), '{}');
      try {
        const port = await start({ env: slow.env });
        const first = await authed(port);
        const second = await authed(port);
        first.socket.send(JSON.stringify({ id: 2, method: 'machine.details' }));
        await until(() => slow.processes('rev-parse').length > 0);
        first.socket.close();
        await first.closed;
        expect(slow.processes().every(alive)).toBe(true);
        second.socket.send(JSON.stringify({ id: 20, method: 'machine.details' }));
        expect(await second.request('machine.history')).toMatchObject({ result: expect.anything() });
        await server!.close();
        forgetServer();
        expect(slow.processes().every((pid) => !alive(pid))).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
      }
    },
  );
});

describe('build.plan', () => {
  function gatedPlans(cleanup = Promise.resolve()) {
    const planCalls: {
      cwd: string;
      platform: string;
      slot?: string;
      finish: () => void;
      fail: (cause: Error) => void;
    }[] = [];
    let cancelled = 0;
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      plan: async (request) => {
        assert(request.platform !== 'macos');
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            cancelled += 1;
            void cleanup.then(
              () => reject(new stim.StimError({ code: 'STIM_CANCELLED', message: 'Cancelled.' })),
              reject,
            );
          };
          request.signal?.addEventListener('abort', stop, { once: true });
          planCalls.push({
            cwd: options.projectRoot,
            platform: request.platform,
            slot: request.slot,
            fail: reject,
            finish: () => {
              request.signal?.removeEventListener('abort', stop);
              resolve();
            },
          });
        });
        const report: BuildPlanPayload = {
          platform: request.platform,
          ...(request.slot ? { slot: request.slot } : {}),
          fingerprint: 'fixture',
          cacheKey: 'fixture',
          cacheHit: false,
          provider: null,
          cacheSkipped: false,
          prebuild: null,
          outcome: 'cold',
          expectedMs: null,
          basis: 0,
        };
        return report;
      },
    }));
    return {
      calls: planCalls,
      get cancelled() {
        return cancelled;
      },
      close: () => {
        for (const call of planCalls) call.finish();
        api.mockRestore();
      },
    };
  }

  for (const retained of [false, true])
    test.skipIf(process.platform === 'win32')(
      `cancels only its own plan and waits for cleanup with retained=${retained}`,
      async () => {
        const refusal = {
          code: 'STIM_CLAIM_UNAVAILABLE',
          message: 'Retained /scratch/plan.',
          remedy: 'Check ownership.',
        };
        let finishCleanup = () => {};
        let releaseCleanup = () => {};
        const cleanup = new Promise<void>((resolve, reject) => {
          releaseCleanup = resolve;
          finishCleanup = () => (retained ? reject(new stim.StimError(refusal)) : resolve());
        });
        const fixture = gatedPlans(cleanup);
        try {
          await start();
          const client = await desktop(),
            other = await desktop();
          void client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'own' }).catch(() => {});
          await until(() => fixture.calls.length === 1);
          expect(await other.request('desktop.plan.cancel', { request: 'own' })).toMatchObject({
            result: { cancelled: false },
          });
          const queued = other.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'own' });
          let ended = false;
          const cancellation = client.request('desktop.plan.cancel', { request: 'own' }).then((result) => {
            ended = true;
            return result;
          });
          await until(() => fixture.cancelled === 1);
          expect(ended).toBe(false);
          expect(await client.request('machine.history')).toMatchObject({ result: expect.anything() });
          expect(ended).toBe(false);
          expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
          finishCleanup();
          expect(await cancellation).toMatchObject({ result: { cancelled: true, ...(retained ? { refusal } : {}) } });
          await until(() => fixture.calls.length === 2);
          fixture.calls[1]?.finish();
          expect(await queued).toHaveProperty('result.platform', 'android');
          expect(await client.request('desktop.plan.cancel', { request: 'own' })).toMatchObject({
            result: { cancelled: false },
          });
          expect(stimCalls()).toEqual([]);
        } finally {
          releaseCleanup();
          fixture.close();
        }
      },
    );

  test.skipIf(process.platform === 'win32')(
    'retains completed cleanup refusals until connection-scoped acknowledgement without evicting them',
    async () => {
      const fixture = gatedPlans();
      const refusal = {
        code: 'STIM_CLAIM_UNAVAILABLE',
        message: 'Retained /scratch/plan.',
        remedy: 'Check ownership.',
      };
      try {
        await start();
        const client = await desktop(),
          other = await desktop();
        for (let index = 0; index < 4; index += 1) {
          const response = client.request('desktop.plan.get', {
            cwd: workspace,
            platform: 'ios',
            request: `plan-${index}`,
          });
          await until(() => fixture.calls.length === index + 1);
          fixture.calls[index]?.fail(new stim.StimError(refusal));
          expect(await response).toMatchObject({ result: refusal });
        }
        expect(await other.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: false },
        });
        expect(
          await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'next' }),
        ).toHaveProperty('error.code', 'limit-exceeded');
        expect(await client.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: true, refusal },
        });
        expect(await client.request('desktop.plan.cancel', { request: 'plan-0' })).toMatchObject({
          result: { cancelled: false },
        });
        const next = client.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'next' });
        await until(() => fixture.calls.length === 5);
        fixture.calls[4]?.finish();
        expect(await next).toHaveProperty('result.platform', 'android');
        expect(await client.request('desktop.plan.cancel', { request: 'plan-3' })).toMatchObject({
          result: { cancelled: true, refusal },
        });
      } finally {
        fixture.close();
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves cleanup refusal after a server deadline and releases admission after acknowledgement',
    async () => {
      const refusal = {
        code: 'STIM_CLAIM_UNAVAILABLE',
        message: 'Retained /scratch/plan.',
        remedy: 'Check ownership.',
      };
      let failCleanup = () => {};
      let releaseCleanup = () => {};
      const cleanup = new Promise<void>((resolve, reject) => {
        releaseCleanup = resolve;
        failCleanup = () => reject(new stim.StimError(refusal));
      });
      const fixture = gatedPlans(cleanup);
      try {
        await start({ commandLimits: { timeoutMs: 100, maxOutputBytes: 1024 * 1024 } });
        const client = await desktop();
        const response = client.request('desktop.plan.get', { cwd: workspace, platform: 'ios', request: 'timeout' });
        await until(() => fixture.calls.length === 1);
        expect(await response).toHaveProperty('error.code', 'stim-failed');
        const cancellation = client.request('desktop.plan.cancel', { request: 'timeout' });
        expect(await client.request('machine.history')).toMatchObject({ result: expect.anything() });
        failCleanup();
        expect(await cancellation).toMatchObject({ result: { cancelled: true, refusal } });
        expect(await client.request('desktop.plan.cancel', { request: 'timeout' })).toMatchObject({
          result: { cancelled: false },
        });
        const next = client.request('desktop.plan.get', { cwd: workspace, platform: 'android', request: 'next' });
        await until(() => fixture.calls.length === 2);
        fixture.calls[1]?.finish();
        expect(await next).toHaveProperty('result.platform', 'android');
      } finally {
        releaseCleanup();
        fixture.close();
      }
    },
  );

  it('plans the registered workspace in-process and preserves the slot', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const client = await authed(port);
      rmSync(join(root, 'fake-stim.mjs'));
      const response = client.request('build.plan', { workspace, platform: 'android', slot: 'tablet' });
      await until(() => fixture.calls.length === 1);
      expect(fixture.calls[0]).toMatchObject({ cwd: workspace, platform: 'android', slot: 'tablet' });
      fixture.calls[0]?.finish();
      expect(await response).toMatchObject({ result: { platform: 'android', slot: 'tablet' } });
      expect(stimCalls()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('refuses a platform, slot or workspace it cannot plan, running nothing', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const client = await authed(port);
      expect(await client.request('build.plan', { workspace, platform: 'web' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      for (const slot of ['', '--device', 'a\u0000b'])
        expect(await client.request('build.plan', { workspace, platform: 'ios', slot })).toMatchObject({
          error: { code: 'bad-request' },
        });
      expect(await client.request('build.plan', { workspace: '/nowhere', platform: 'ios' })).toMatchObject({
        error: { code: 'unknown-workspace' },
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('runs one plan at a time per workspace, across connections', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const first = await authed(port),
        second = await authed(port);
      const ios = first.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      const android = second.request('build.plan', { workspace, platform: 'android' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      fixture.calls[0]?.finish();
      expect(await ios).toHaveProperty('result.platform', 'ios');
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      fixture.close();
    }
  });

  it('drops the queued plans of a closed connection and lets the next one run', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const closing = await authed(port),
        staying = await authed(port);
      void closing.request('build.plan', { workspace, platform: 'ios' });
      void closing.request('build.plan', { workspace, platform: 'android' });
      await until(() => fixture.calls.length === 1);
      const response = staying.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
      closing.socket.close();
      await until(() => fixture.calls.length === 2);
      expect(fixture.calls.map((call) => [call.platform, call.slot])).toEqual([
        ['ios', undefined],
        ['ios', 'tablet'],
      ]);
      fixture.calls[1]?.finish();
      expect(await response).toHaveProperty('result.platform', 'ios');
    } finally {
      fixture.close();
    }
  });

  it('keeps the next plan queued until a timed-out plan finishes cleanup', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = gatedPlans(cleanup);
    try {
      const port = await start({ commandLimits: { timeoutMs: 1000 } });
      const first = await authed(port),
        second = await authed(port);
      const ios = first.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      const android = second.request('build.plan', { workspace, platform: 'android' });
      expect(await ios).toHaveProperty('error.code', 'stim-failed');
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      release();
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      release();
      fixture.close();
    }
  });

  it('keeps later plans waiting when a queued plan ahead of them is dropped', async () => {
    const fixture = gatedPlans();
    try {
      const port = await start();
      const staying = await authed(port),
        closing = await authed(port);
      const ios = staying.request('build.plan', { workspace, platform: 'ios' });
      await until(() => fixture.calls.length === 1);
      void closing.request('build.plan', { workspace, platform: 'ios', slot: 'tablet' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const android = staying.request('build.plan', { workspace, platform: 'android' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      closing.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fixture.calls.map((call) => call.platform)).toEqual(['ios']);
      fixture.calls[0]?.finish();
      expect(await ios).toHaveProperty('result.platform', 'ios');
      await until(() => fixture.calls.length === 2);
      fixture.calls[1]?.finish();
      expect(await android).toHaveProperty('result.platform', 'android');
    } finally {
      fixture.close();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'limits selected-folder plans to the proved Desktop and validates its native selectors',
    async () => {
      const port = await start();
      const phone = await authed(port);
      assert(server);
      const plain = await localConnect(server);
      await plain.request('hello', { client: CLIENT });
      for (const client of [phone, plain])
        expect(await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios' })).toHaveProperty(
          'error.code',
          'forbidden',
        );
      const client = await desktop();
      for (const params of [
        {},
        { cwd: '.', platform: 'ios' },
        { cwd: workspace, platform: 'web' },
        { cwd: workspace, platform: 'macos', slot: 'preview' },
        { cwd: workspace, platform: 'ios', slot: '--device' },
        { cwd: workspace, platform: 'ios', extra: true },
        { cwd: join(root, 'missing'), platform: 'android' },
      ])
        expect(await client.request('desktop.plan.get', params)).toHaveProperty('error.code', 'bad-request');
      writeFileSync(join(workspace, 'package.json'), '{}');
      rmSync(join(root, 'fake-stim.mjs'));
      expect(await client.request('desktop.plan.get', { cwd: workspace, platform: 'ios' })).toMatchObject({
        result: {
          code: 'STIM_NO_PROJECT',
          message: expect.stringContaining(join(workspace, 'package.json')),
          remedy: expect.stringContaining('package.json'),
        },
      });
      expect(stimCalls()).toEqual([]);
    },
  );

  describe.skipIf(process.platform !== 'darwin')('macOS planning', () => {
    it('plans an unregistered macOS app through the real API without compiling or launching', async () => {
      const selected = join(root, 'native-app');
      mkdirSync(selected);
      writeFileSync(join(selected, 'Package.swift'), '// swift-tools-version: 6.0\n');
      writeFileSync(
        join(selected, 'Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.fixture.plan</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
      );
      writeFileSync(
        join(selected, '.stim.json'),
        JSON.stringify({ macos: { product: 'Fixture', infoPlist: 'Info.plist' } }),
      );
      await start({ env: { STIM_REMOTE_BUILD: 'local' } });
      const client = await desktop();
      rmSync(join(root, 'fake-stim.mjs'));
      expect(await client.request('desktop.plan.get', { cwd: selected, platform: 'macos' })).toMatchObject({
        result: {
          platform: 'macos',
          product: 'Fixture',
          buildMachine: 'local',
          cacheHit: false,
          cacheKey: null,
        },
      });
      expect(existsSync(join(selected, '.build'))).toBe(false);
      expect(stimCalls()).toEqual([]);
    });
  });

  it('reports a real planner refusal with its code, message and remedy without a CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const port = await start();
    const client = await authed(port);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('build.plan', { workspace, platform: 'android' })).toMatchObject({
      error: { code: 'stim-failed', message: expect.stringContaining('STIM_NO_PROJECT:') },
    });
    expect(stimCalls()).toEqual([]);
  });
});
