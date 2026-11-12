import {
  registryWatch,
  RECORDS,
  PAYLOADS,
  fakeTailscale,
  CLIENT,
  root,
  calls,
  workspace,
  server,
  reloadBrowser,
  start,
  connect,
  openPlain,
  pair,
  returning,
  DESKTOP_KEY,
  desktopProof,
  desktop,
  alive,
  until,
  statusWorkers,
  childPids,
  stimCalls,
  authed,
  records,
  linkedHome,
  liveLogFixture,
  forgetServer,
} from './server-harness.ts';
import assert from 'node:assert';
import { once } from 'node:events';
import {
  cpSync,
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer, get } from 'node:http';
import { randomUUID } from 'node:crypto';
import { connect as connectNet, createServer as createNetServer, type Socket } from 'node:net';
import { homedir, networkInterfaces, totalmem } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { duplexPair } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  archiveDir,
  closedSegmentName,
  recordingDeviceName,
  type ArchivedWorkspace,
  readStatsReport,
  readWorkspaceState,
  isJsonObject,
  loadConfig,
  settingsJsonSchema,
} from '@stim-cli/core/state';
import { createStim } from 'stim';
import * as stimSelf from 'stim/api-self';
import { DesktopBootstrap } from '../src/desktop-bootstrap.ts';
import { HostedAgentHost } from '../src/agent-driver.ts';
import { DeviceHost } from '../src/device-host.ts';
import { FeedPool } from '../src/feed.ts';
import { FramePool } from '../src/frames.ts';
import {
  DESKTOP_API,
  HOST_CAPABILITIES,
  PEER,
  PHONE_API,
  protocolJsonSchema,
  type ArchiveDetailResult,
  type HelloResult,
  type MachineUsage,
  type MachineEvent,
  type WorkspacesEvent,
  type ArchivedListResult,
} from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { readAudit } from '../src/actions.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  PAIRING_TTL_MS,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  readTestClients,
  revokeDevice,
  serverDir,
  serverIdentity,
  spendSecret,
  storeSetupSecret,
} from '../src/registry.ts';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { newSecret, secretValues } from '@stim-cli/core/noise-session';
import { localConnect, noiseConnect, openRaw, setupClient } from './noise-client.ts';
import { watchTailscale, type TailscaleState } from '@stim-cli/transport-tailscale';
import { localTransport } from '@stim-cli/transport-local';
import { FakeHolder } from './keep-awake-holder.ts';
import type { Transport } from '@stim-cli/transport';
import { createRequestLog } from '../src/request-log.ts';
import { upgradeFromWebPage, type ServerOptions } from '../src/server.ts';
import { workspaceName, workspaceStateDir } from '@stim-cli/core';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { readPid } from './pid-file.ts';

test('server close cancels a home identity waiting on the config lock', async () => {
  const lock = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' }).acquired;
  assert(lock);
  let entered = false;
  const original = stimSelf.createStim;
  const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => {
    const client = original(options);
    return {
      ...client,
      identity: (...args) => {
        entered = true;
        return client.identity(...args);
      },
    };
  });
  try {
    await start({ settle: false, statusAtBoot: false, record: false });
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
    assert(server);
    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('server close waited for the lock')), 1000)),
    ]);
    forgetServer();
    releaseClaim(lock);
    rmSync(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(root, 'home'))).toBe(false);
  } finally {
    api.mockRestore();
    releaseClaim(lock);
  }
});

test('an agent shutdown failure still closes hosted devices, frames, feeds and listeners', async () => {
  const port = await start();
  const client = await authed(port);
  const agentClose = vi.spyOn(HostedAgentHost.prototype, 'close').mockRejectedValue(new Error('daemon unresolved'));
  const hostedClose = vi.spyOn(DeviceHost.prototype, 'close');
  const frameClose = vi.spyOn(FramePool.prototype, 'close');
  const feedClose = vi.spyOn(FeedPool.prototype, 'close');
  try {
    await expect(server!.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'daemon unresolved' })],
    });
    expect(hostedClose).toHaveBeenCalledOnce();
    expect(frameClose).toHaveBeenCalledOnce();
    expect(feedClose).toHaveBeenCalledOnce();
    await client.closed;
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow('fetch failed');
    forgetServer();
  } finally {
    agentClose.mockRestore();
    hostedClose.mockRestore();
    frameClose.mockRestore();
    feedClose.mockRestore();
  }
});

describe('recorder startup', () => {
  test('serves health when recording claim directories do not exist yet', async () => {
    const port = await start({ record: true, env: { FAKE_STIM_PAYLOADS: '[]' } });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ server: 'stim-server' });
  });

  test.skipIf(process.platform === 'win32')(
    'keeps serving after the recorder refuses an unreadable claim directory',
    async () => {
      const exclusive = join(process.env.STIM_HOME!, 'server', 'recorder', 'exclusive');
      mkdirSync(exclusive, { recursive: true });
      chmodSync(exclusive, 0o000);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const port = await start({ record: true, env: { FAKE_STIM_PAYLOADS: '[]' } });
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('its directory could not be read'));
      } finally {
        chmodSync(exclusive, 0o700);
        error.mockRestore();
      }
    },
  );

  describe('while a Stim home directory read does not return', () => {
    const blockRead = (name: string) => {
      const preload = join(root, `${name}.cjs`);
      const pidFile = join(root, `${name}.pid`);
      const release = join(root, `${name}.release`);
      writeFileSync(
        preload,
        `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
fs.readdirSync = () => {
  if (fs.existsSync(process.env.PROBE_RELEASE_FILE)) return [];
  fs.writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
  process.on('SIGTERM', () => {});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
syncBuiltinESMExports();
`,
      );
      return {
        pidFile,
        release,
        env: {
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
          PROBE_PID_FILE: pidFile,
          PROBE_RELEASE_FILE: release,
        },
      };
    };

    test('listens at once, reports degraded health, serves no clients and starts no recorder', async () => {
      const blocked = blockRead('blocked-read');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const port = await start({
        record: true,
        settle: false,
        startupProbeMs: 400,
        startupRetryMs: 60_000,
        env: blocked.env,
      });
      try {
        const pending = await fetch(`http://127.0.0.1:${port}/health`);
        expect(pending.status).toBe(503);
        expect(await pending.json()).toMatchObject({ server: 'stim-server', startup: { state: 'pending' } });

        const settled = await server!.ready;
        expect(settled).toEqual({
          state: 'degraded',
          reason: expect.stringContaining('did not finish within 0.4 s'),
          cause: 'home-unreadable',
        });
        const degraded = await fetch(`http://127.0.0.1:${port}/health`);
        expect(degraded.status).toBe(503);
        expect(await degraded.json()).toMatchObject({ startup: settled });

        const forwarded = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { 'x-forwarded-for': '100.64.0.2' },
        });
        expect(forwarded.status).toBe(503);
        expect(await forwarded.json()).toEqual({
          version: expect.any(String),
          startup: { state: 'degraded', cause: 'home-unreadable' },
        });

        await expect(
          new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
            socket.once('error', reject);
          }),
        ).resolves.toBe(503);

        expect(existsSync(calls)).toBe(false);
        expect(existsSync(join(process.env.STIM_HOME!, 'server'))).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('not serving clients'));
        const pid = await readPid(blocked.pidFile);
        expect(() => process.kill(pid, 0)).toThrow('ESRCH');
      } finally {
        error.mockRestore();
      }
    });

    test.skipIf(process.platform === 'win32')(
      'does not read Stim home files from timers before the first read returns',
      async () => {
        const blocked = blockRead('sweep-read');
        const config = join(root, 'home', 'config.json');
        const opened = join(root, 'config-opened');
        rmSync(config, { force: true });
        execFileSync('mkfifo', [config]);
        const opener = spawn(process.execPath, [
          '-e',
          `const fs = require('node:fs');
for (;;) { fs.closeSync(fs.openSync(${JSON.stringify(config)}, 'w')); fs.writeFileSync(${JSON.stringify(opened)}, ''); }`,
        ]);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await start({
            settle: false,
            startupProbeMs: 10_000,
            startupRetryMs: 60_000,
            buildLimits: { daemonSweepMs: 30 },
            env: blocked.env,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(existsSync(opened)).toBe(false);
        } finally {
          await server?.close();
          forgetServer();
          opener.kill('SIGKILL');
          error.mockRestore();
        }
      },
    );

    test('stops promptly while the first read is still out', async () => {
      const blocked = blockRead('closing-read');
      await start({ settle: false, startupProbeMs: 10_000, env: blocked.env });
      const started = Date.now();
      await server!.close();
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await server!.ready).state).toBe('pending');
    });

    test('becomes ready without a restart once the read returns', async () => {
      const blocked = blockRead('recovering-read');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const port = await start({
        record: true,
        settle: false,
        startupProbeMs: 400,
        startupRetryMs: 50,
        env: { FAKE_STIM_PAYLOADS: '[]', ...blocked.env },
      });
      try {
        expect((await server!.ready).state).toBe('degraded');
        writeFileSync(blocked.release, '');
        await vi.waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ startup: { state: 'ready' } });
        });
        await expect(pair(port)).resolves.toHaveProperty('id');
      } finally {
        error.mockRestore();
      }
    }, 20_000);
  });
});

describe.skipIf(process.platform === 'win32')('private Desktop bootstrap on the local socket', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const isHello = validator.compile<HelloResult>({ $ref: 'protocol#/$defs/HelloResult' });

  /** A local-socket client that asks for the challenge, as Stim Desktop does, without answering it yet. */
  async function asking(client: Record<string, unknown> = CLIENT) {
    const socket = await localConnect(server!);
    const reply = await socket.request('hello', { client, desktopBootstrap: true });
    assert('result' in reply && isHello(reply.result));
    return { client: socket, hello: reply.result };
  }

  function challenge(hello: HelloResult) {
    assert(hello.desktopBootstrap);
    return hello.desktopBootstrap;
  }

  it('admits the parent proof to the Desktop-only methods, which a plain local client such as the CLI never gets', async () => {
    await start();
    const { client, hello } = await asking();
    const offered = challenge(hello);
    expect(JSON.stringify(hello)).not.toContain(DESKTOP_KEY);
    expect(await client.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    expect(await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toMatchObject({
      result: { authorized: true },
    });
    expect(await client.request('device-host.sessions')).toHaveProperty('result');

    const cli = await localConnect(server!);
    const plain = await cli.request('hello', { client: { name: 'stim', version: '1' } });
    expect(plain).toMatchObject({ result: { capabilities: ['read', 'control'] } });
    expect(plain).not.toHaveProperty('result.desktopBootstrap');
    expect(await cli.request('stats.get')).toHaveProperty('result');
    expect(await cli.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    expect(await cli.request('route.setup')).toHaveProperty('error.code', 'forbidden');
    expect(await cli.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
  });

  it('does not confuse a Desktop name, the key itself or the public server proof with the client proof', async () => {
    await start();
    for (const params of [undefined, {}, { proof: DESKTOP_KEY }, { proof: 'x'.repeat(43) }, 'server', 'extra']) {
      const { client, hello } = await asking({ name: 'Stim Desktop', version: '1' });
      const offered = challenge(hello);
      const sent =
        params === 'server'
          ? { proof: offered.proof }
          : params === 'extra'
            ? { proof: desktopProof(offered.nonce), desktop: true }
            : params;
      expect(await client.request('desktop.authenticate', sent)).toHaveProperty('error.code', 'forbidden');
      expect(await client.request('route.setup')).toHaveProperty('error.code', 'forbidden');
    }
  });

  it('answers one proof per challenge and refuses an earlier proof after reconnect', async () => {
    await start();
    const first = await asking();
    const accepted = desktopProof(challenge(first.hello).nonce);
    expect(await first.client.request('desktop.authenticate', { proof: 'y'.repeat(43) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(await first.client.request('desktop.authenticate', { proof: accepted })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    first.client.socket.close();
    const second = await asking();
    expect(challenge(second.hello).nonce).not.toBe(challenge(first.hello).nonce);
    expect(await second.client.request('desktop.authenticate', { proof: accepted })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    const third = await asking();
    expect(
      await third.client.request('desktop.authenticate', { proof: desktopProof(challenge(third.hello).nonce) }),
    ).toHaveProperty('result.authorized', true);
  });

  it('a server Desktop did not start offers no challenge and grants its local socket, not its network clients, the Desktop methods', async () => {
    await start({ desktopBootstrap: null });
    const client = await localConnect(server!);
    const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    expect(hello).toMatchObject({ result: { capabilities: ['read', 'control'] } });
    expect(hello).not.toHaveProperty('result.desktopBootstrap');
    for (const method of ['desktop.gc.subscribe', 'desktop.start.subscribe', 'desktop.worktree.remove.subscribe'])
      expect(await client.request(method, {})).toHaveProperty('error.code', 'bad-request');
    const write = { cwd: root, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    expect(await client.request('desktop.settings.write', write)).toHaveProperty('result.changed', true);
    expect(loadConfig()?.concurrency?.maxBuilds).toBe(3);
    expect(await client.request('device-host.sessions')).toHaveProperty('result');
    expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
      'error.code',
      'forbidden',
    );

    const port = server!.addresses[0]!.port;
    const { keyPair } = await pair(port, undefined, true);
    const network = await connect(port, undefined, { keyPair });
    await network.request('hello', { client: CLIENT });
    expect(await network.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    expect(await network.request('desktop.settings.write', { ...write, value: '5' })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(loadConfig()?.concurrency?.maxBuilds).toBe(3);
  });

  it('keeps a Desktop-started server closed to a local client that does not prove its key', async () => {
    await start();
    const { client } = await asking();
    const write = { cwd: root, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    expect(await client.request('desktop.settings.write', write)).toHaveProperty('error.code', 'forbidden');
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    expect(await plain.request('desktop.settings.write', write)).toHaveProperty('error.code', 'forbidden');
    expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
  });

  it('tells a local client the TCP port of the server behind the socket, and network clients nothing', async () => {
    const port = await start();
    const local = await localConnect(server!);
    expect(await local.request('hello', { client: CLIENT })).toHaveProperty('result.server.port', port);
    const { keyPair } = await pair(port, undefined, true);
    const network = await connect(port, undefined, { keyPair });
    expect(await network.request('hello', { client: CLIENT })).not.toHaveProperty('result.server.port');
  });

  it('a replacement server requires its own parent key', async () => {
    await start();
    await server?.close();
    forgetServer();
    const replacement = Buffer.alloc(32, 8).toString('base64url');
    await start({ desktopBootstrap: new DesktopBootstrap(replacement) });
    const { client, hello } = await asking();
    const offered = challenge(hello);
    expect(await client.request('desktop.authenticate', { proof: desktopProof(offered.nonce) })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    const again = await asking();
    expect(
      await again.client.request('desktop.authenticate', {
        proof: desktopProof(challenge(again.hello).nonce, replacement),
      }),
    ).toHaveProperty('result.authorized', true);
  });

  it.each([
    ['forwarded', { 'x-forwarded-for': '100.64.0.2' }],
    ['rebound host', { host: 'attacker.example' }],
  ])('a %s network client with control gets no challenge, even on loopback', async (_name, headers) => {
    const port = await start();
    const { keyPair } = await pair(port, undefined, true);
    const client = await connect(port, undefined, { keyPair, headers });
    const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    expect(hello).not.toHaveProperty('result.desktopBootstrap');
    expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
      'error.code',
      'forbidden',
    );
  });

  it('refuses a browser page before any hello, on loopback too', async () => {
    const port = await start();
    const { keyPair } = await pair(port, undefined, true);
    await expect(connect(port, undefined, { keyPair, headers: { origin: 'http://127.0.0.1' } })).rejects.toThrow(
      'HTTP 403',
    );
  });

  test.skipIf(!fakeTailscale)(
    'a tailnet client whose control was revoked has no route to Desktop authority',
    async () => {
      const port = await start();
      const { id, keyPair } = await pair(port, '100.64.0.2', true);
      grantDevice(id, capabilitiesFor(false));
      const client = await connect(port, '100.64.0.2', { keyPair });
      const hello = await client.request('hello', { client: CLIENT, desktopBootstrap: true });
      expect(hello).toMatchObject({ result: { capabilities: ['read'] } });
      expect(hello).not.toHaveProperty('result.desktopBootstrap');
      expect(await client.request('desktop.authenticate', { proof: DESKTOP_KEY })).toHaveProperty(
        'error.code',
        'forbidden',
      );
      expect(await client.request('device-host.sessions')).toHaveProperty('error.code', 'forbidden');
    },
  );
});

describe('pairing', () => {
  it('lists only the Android phone capability in hello.host from a machine that is not a Mac', async () => {
    const port = await start({ hostsDevices: false });
    const { token } = createPairingToken();
    const client = await connect(port, undefined, { secret: token, keyPair: generateNoiseKeyPair() });
    const hello = await client.request('hello', { client: CLIENT });
    expect(hello).toHaveProperty('result.host.capabilities', ['physical-android']);
  });
  it('refuses a network client below its wire integer with the remedy for its surface, and serves it on the local socket', async () => {
    const port = await start();
    const worker = setupClient(['build']);
    const cli = await connect(port, undefined, { keyPair: worker.keyPair });
    expect(
      await cli.request('hello', { client: { name: 'stim', version: '1', runId: 'old', peer: 2 }, access: 'build' }),
    ).toEqual({
      id: expect.any(Number),
      error: {
        code: 'protocol-unsupported',
        message: `peer-too-old: Test Mac runs stim 9.9.9 (peer ${PEER}); update this Mac: npm i -g stim@9.9.9`,
      },
    });
    expect(await cli.closedWith).toEqual({ code: 4401, reason: 'protocol-unsupported' });
    const current = await connect(port, undefined, { keyPair: worker.keyPair });
    expect(await current.request('hello', { client: CLIENT, access: 'build' })).toHaveProperty('result.peer', PEER);

    const { keyPair } = await pair(port);
    const phone = 'Update Stim Mobile from the App Store or TestFlight.';
    for (const [client, remedy] of [
      [{ name: 'iPhone', version: '1.0.0' }, phone],
      [{ name: 'iPhone', version: '1.0.0', phoneApi: PHONE_API - 1 }, phone],
      [
        { name: 'Stim Desktop', version: '0.9.0', desktopApi: DESKTOP_API - 1 },
        'Update Stim Desktop (Stim > Check for Updates).',
      ],
      [{ name: 'Stim Desktop', version: '0.9.0' }, 'Update Stim Desktop (Stim > Check for Updates).'],
    ] as const) {
      const older = await connect(port, undefined, { keyPair });
      expect(await older.request('hello', { client })).toMatchObject({
        error: { code: 'protocol-unsupported', message: expect.stringContaining(remedy) },
      });
    }
    const local = await localConnect(server!);
    expect(await local.request('hello', { client: { name: 'stim', version: '1' } })).toHaveProperty(
      'result.peer',
      PEER,
    );
  });

  it('records the app and version a hello names without changing what the device may do', async () => {
    const port = await start();
    const keyPair = generateNoiseKeyPair();
    const { token } = createPairingToken();
    const first = await connect(port, undefined, { secret: token, keyPair });
    const paired = await first.request('hello', {
      client: { name: 'Stim Desktop', version: '1.4.0', desktopApi: DESKTOP_API },
    });
    expect(paired).toMatchObject({ result: { capabilities: ['read'] } });
    first.socket.close();
    expect(readDevices()).toEqual([
      expect.objectContaining({ clientApp: 'Stim Desktop', clientVersion: '1.4.0', capabilities: ['read'] }),
    ]);

    const returningHello = await (await connect(port, undefined, { keyPair })).request('hello', { client: CLIENT });
    expect(returningHello).toMatchObject({ result: { capabilities: ['read'] } });
    expect(readDevices()[0]).toMatchObject({ clientApp: 'Stim Desktop', clientVersion: '1.4.0' });
  });

  it('fills in the app of a record paired before it was recorded on its next connection', async () => {
    const port = await start();
    const keyPair = generateNoiseKeyPair();
    const { token } = createPairingToken();
    const spent = spendSecret(
      secretValues(Buffer.from(token, 'base64url')).lookup.toString('hex'),
      keyPair.publicKey.toString('base64url'),
      'Old phone',
      'test',
    );
    assert(spent?.device);
    expect(spent.device).not.toHaveProperty('clientApp');
    const client = await connect(port, undefined, { keyPair });
    await client.request('hello', { client: { name: 'stim-mobile', version: '0.9.0', phoneApi: PHONE_API } });
    expect(readDevices()).toEqual([{ ...spent.device, clientApp: 'stim-mobile', clientVersion: '0.9.0' }]);
  });

  it('records the key that spends a pairing token, with the token capabilities, and refuses a second use', async () => {
    const port = await start();
    const keyPair = generateNoiseKeyPair();
    const { token } = createPairingToken();
    const first = await connect(port, undefined, { secret: token, keyPair, name: 'Test phone' });
    expect(first.socket).toHaveProperty('remoteKey', serverIdentity().publicKey);
    const reply = await first.request('hello', { client: CLIENT, access: 'build' });
    expect(reply).toMatchObject({ error: { code: 'forbidden' } });
    expect(await first.closedWith).toEqual({ code: 4401, reason: 'forbidden' });
    expect(readDevices()).toEqual([
      expect.objectContaining({
        name: 'Test phone',
        publicKey: keyPair.publicKey.toString('base64url'),
        capabilities: ['read'],
      }),
    ]);
    expect(readBuildClients()).toEqual([]);
    expect(readFileSync(join(root, 'home', 'server', 'secrets.json'), 'utf8')).not.toContain(token);

    const hello = await (await connect(port, undefined, { keyPair })).request('hello', { client: CLIENT });
    expect(hello).toMatchObject({
      result: {
        protocol: 2,
        server: { name: 'Test Mac', version: '1.2.3', stim: '9.9.9', home: homedir() },
        capabilities: ['read'],
        host: { capabilities: [...HOST_CAPABILITIES], app: null },
        peer: PEER,
        phoneApi: PHONE_API,
        desktopApi: DESKTOP_API,
        actions: [],
        device: { name: 'Test phone' },
      },
    });

    const second = await connect(port, undefined, { secret: token });
    expect(await second.closedWith).toEqual({ code: 4401, reason: 'unknown-secret' });
    expect(readDevices()).toHaveLength(1);
  });

  it('logs why it could not record a new client when a newer Stim wrote the registry', async () => {
    const port = await start();
    const { token } = createPairingToken();
    writeFileSync(join(serverDir(), 'devices.json'), JSON.stringify({ version: 3, devices: [] }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await connect(port, undefined, { secret: token });
    expect(await client.closedWith).toEqual({ code: 4401, reason: 'home-unavailable' });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('registry version 3, which a newer Stim wrote'));
  });

  it('refuses an expired pairing token', async () => {
    const port = await start();
    const { token } = createPairingToken(Date.now() - PAIRING_TTL_MS - 1000);
    await expect(connect(port, undefined, { secret: token })).rejects.toMatchObject({ code: 'unknown-secret' });
    expect(readDevices()).toEqual([]);
  });

  it('closes a returning key that has no record as unauthorized', async () => {
    const port = await start();
    const stranger = await connect(port, '100.64.0.2');
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('refuses hello for a record revoked between the handshake and hello', async () => {
    const port = await start();
    const { id, keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    expect(revokeDevice(id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reply = client.request('hello', { client: CLIENT });
    expect(await Promise.race([reply, client.closedWith])).not.toHaveProperty('result');
    expect(await client.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  it('refuses a server that does not hold the key the client pinned', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    await expect(
      connect(port, undefined, { keyPair, serverKey: generateNoiseKeyPair().publicKey }),
    ).rejects.toMatchObject({ code: 'server-key-mismatch' });
  });

  it('answers a protocol 1 hello in the clear with protocol-unsupported', async () => {
    const port = await start();
    const old = await openPlain(port);
    const reply = await old.request('hello', {
      protocol: 1,
      client: CLIENT,
      auth: { pairingToken: createPairingToken().token, deviceName: 'Old phone' },
    });
    expect(reply).toMatchObject({ id: 1, error: { code: 'protocol-unsupported' } });
    expect(await old.closed).toBe(4400);
    expect(readDevices()).toEqual([]);
  });

  it.each([false, true])(
    'closes revoked sessions and refuses the key with watch events dropped: %s',
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      if (dropEvents) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const port = await start();
        const { id, keyPair } = await pair(port);
        const live = await returning(port, keyPair);

        expect(revokeDevice(id)).toBe(true);
        if (dropEvents) await vi.runOnlyPendingTimersAsync();
        expect(await live.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
        const after = await connect(port, undefined, { keyPair });
        expect(await after.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
        expect(revokeDevice(id)).toBe(false);
      } finally {
        if (dropEvents) {
          try {
            await server?.close();
            forgetServer();
          } finally {
            vi.useRealTimers();
          }
        }
      }
    },
  );
  it('keeps sessions and revokes nothing while the Stim home is away, then serves again once it is back', async () => {
    const home = linkedHome();
    const port = await start();
    const { keyPair } = await pair(port);
    const live = await returning(port, keyPair);
    const waiting = await connect(port, undefined, { keyPair });
    const revoke = vi.spyOn(DeviceHost.prototype, 'revoke');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).status;
    try {
      home.away();
      for (let tries = 0; tries < 300 && (await health()) !== 503; tries++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({
        startup: { state: 'degraded', cause: 'home-unreadable' },
      });
      const reply = waiting.request('hello', { client: CLIENT });
      expect(await Promise.race([reply, waiting.closedWith])).not.toHaveProperty('result');
      expect(await waiting.closedWith).toEqual({ code: 4401, reason: 'home-unavailable' });
      await expect(connect(port, undefined, { keyPair })).rejects.toThrow('503');
      expect(live.socket.readyState).toBe(WebSocket.OPEN);
      expect(revoke).not.toHaveBeenCalled();

      home.back();
      for (let tries = 0; tries < 300 && (await health()) !== 200; tries++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await health()).toBe(200);
      expect(logged).toHaveBeenCalledWith('stim-server: the Stim home answers again; serving clients.');
      expect(live.socket.readyState).toBe(WebSocket.OPEN);
      (await returning(port, keyPair)).socket.close();
    } finally {
      revoke.mockRestore();
      logged.mockRestore();
    }
  });

  it('still closes hosted devices when it stops while the Stim home is away', async () => {
    const home = linkedHome();
    const port = await start();
    const hostedClose = vi.spyOn(DeviceHost.prototype, 'close');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      home.away();
      for (let tries = 0; tries < 300; tries++) {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 503) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
      await server?.close();
      forgetServer();
      expect(hostedClose).toHaveBeenCalledOnce();
    } finally {
      hostedClose.mockRestore();
      logged.mockRestore();
    }
  });
});

describe('setup approval', () => {
  test('a setup ticket records build and device-host access for one key, once', async () => {
    const port = await start();
    const ticket = newSecret();
    storeSetupSecret(
      Buffer.from(ticket, 'base64url'),
      ['build', 'device-host'],
      new Date(Date.now() + 60_000).toISOString(),
    );
    const keyPair = generateNoiseKeyPair();
    const first = await connect(port, '100.64.0.2', { secret: ticket, keyPair, name: 'Laptop' });
    expect(await first.request('hello', { client: CLIENT, access: 'build' })).toMatchObject({
      result: { capabilities: ['build'], actions: [] },
    });
    const journal = secretValues(Buffer.from(ticket, 'base64url')).journal;
    const key = keyPair.publicKey.toString('base64url');
    expect(readBuildClients()).toEqual([
      expect.objectContaining({ name: 'Laptop', publicKey: key, capabilities: ['build'], setupJournal: journal }),
    ]);
    expect(readDeviceHostClients()).toEqual([
      expect.objectContaining({ publicKey: key, capabilities: ['device-host'], setupJournal: journal }),
    ]);
    expect(readDevices()).toEqual([]);
    const secrets = readFileSync(join(root, 'home', 'server', 'secrets.json'), 'utf8');
    expect(secrets).not.toContain(ticket);
    const other = await connect(port, '100.64.0.2', { secret: ticket });
    expect(await other.closedWith).toEqual({ code: 4401, reason: 'unknown-secret' });

    const unpaired = await connect(port, '100.64.0.2', { keyPair });
    expect(await unpaired.request('hello', { client: CLIENT })).toMatchObject({ error: { code: 'unauthorized' } });
  });

  test('a test ticket records test access alone, which a build client and this machine never get', async () => {
    const port = await start();
    const ticket = newSecret();
    storeSetupSecret(Buffer.from(ticket, 'base64url'), ['test'], new Date(Date.now() + 60_000).toISOString());
    const keyPair = generateNoiseKeyPair();
    const first = await connect(port, '100.64.0.2', { secret: ticket, keyPair, name: 'Laptop' });
    expect(await first.request('hello', { client: CLIENT, access: 'test' })).toMatchObject({
      result: { capabilities: ['test'], actions: [] },
    });
    expect(readTestClients()).toEqual([
      expect.objectContaining({
        name: 'Laptop',
        publicKey: keyPair.publicKey.toString('base64url'),
        capabilities: ['test'],
      }),
    ]);
    expect([...readDevices(), ...readBuildClients(), ...readDeviceHostClients()]).toEqual([]);

    const builder = setupClient(['build']);
    const asking = await connect(port, '100.64.0.3', { keyPair: builder.keyPair });
    expect(await asking.request('hello', { client: CLIENT, access: 'test' })).toMatchObject({
      error: { code: 'forbidden' },
    });

    assert(server);
    const local = await localConnect(server);
    expect(await local.request('hello', { client: CLIENT, access: 'test' })).toMatchObject({
      error: { code: 'forbidden' },
    });
  });

  describe.each(['build', 'device-host', 'test'] as const)('%s access', (capability) => {
    test('serves no read method and only its own capability, until revoked', async () => {
      const port = await start();
      const { keyPair, records: made } = setupClient([capability]);
      const approved = await returning(port, keyPair, '100.64.0.2', capability);
      const otherCapability: [string, unknown][] =
        capability === 'build'
          ? [['device-host.offer', { platform: 'ios' }]]
          : capability === 'device-host'
            ? [
                ['build.offer', undefined],
                ['control.begin', { workspace: '/unrelated', slot: 'ios' }],
              ]
            : [
                ['build.offer', undefined],
                ['device-host.offer', { platform: 'ios' }],
                ['control.begin', { workspace: '/unrelated', slot: 'ios' }],
              ];
      const refused: [string, unknown][] = [
        ['machine.subscribe', undefined],
        ['machine.get', undefined],
        ['notifications.list', undefined],
        ['stats.get', undefined],
        ['machine.details', undefined],
        ...otherCapability,
      ];
      for (const [method, params] of refused) {
        expect(await approved.request(method, params)).toMatchObject({ error: { code: 'forbidden' } });
      }
      for (const other of (['build', 'device-host', 'test'] as const).filter((each) => each !== capability)) {
        const wider = await connect(port, '100.64.0.2', { keyPair });
        expect(await wider.request('hello', { client: CLIENT, access: other })).toMatchObject({
          error: { code: 'forbidden' },
        });
      }

      expect(revokeDevice(made[capability]!.id)).toBe(true);
      expect(await approved.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
    });
  });
});

describe('health', () => {
  test.skipIf(process.platform === 'win32')(
    'shares a permission probe across concurrent health and authenticated hello, then refreshes grants',
    async () => {
      const executable = join(root, 'host-probe');
      const grants = join(root, 'grants.json');
      const probes = join(root, 'probes');
      writeFileSync(grants, JSON.stringify({ screenRecording: false, accessibility: true }));
      writeFileSync(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
setTimeout(() => console.log(fs.readFileSync(${JSON.stringify(grants)}, 'utf8')), 50);
`,
        { mode: 0o755 },
      );
      const port = await start({ host: { executable, name: 'Stim Host Dev' } });
      const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { host: unknown };
      const client = await connect(port, undefined, { secret: createPairingToken().token });
      const [first, second, hello] = await Promise.all([
        health(),
        health(),
        client.request('hello', { client: CLIENT }),
      ]);
      expect(first.host).toEqual({ name: 'Stim Host Dev', screenRecording: false, accessibility: true });
      expect(second.host).toEqual(first.host);
      expect(hello).toMatchObject({ result: { host: { app: first.host } } });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsHello = validator.compile({ $ref: 'protocol#/$defs/HelloResult' });
      if (!('result' in hello)) throw new Error(JSON.stringify(hello));
      expect(acceptsHello(hello.result)).toBe(true);
      expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(1);
      writeFileSync(grants, JSON.stringify({ screenRecording: true, accessibility: true }));
      expect((await health()).host).toEqual(first.host);
      const now = Date.now();
      const date = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
      try {
        expect((await health()).host).toEqual({ name: 'Stim Host Dev', screenRecording: true, accessibility: true });
        expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
      } finally {
        date.mockRestore();
      }
    },
  );

  it('reports unavailable grants when the host probe fails', async () => {
    const port = await start({ host: { executable: join(root, 'missing'), name: 'Stim Host Dev' } });
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty('host', null);
  });

  it('serves only this machine when loopback only, refusing peers a tailscale serve route forwards', async () => {
    const port = await start({ loopbackOnly: true });
    const local = await fetch(`http://127.0.0.1:${port}/health`);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ loopbackOnly: true });
    const forwarded = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
    expect(forwarded.status).toBe(403);
    await expect(connect(port, '100.64.0.2')).rejects.toThrow('HTTP 403');
    await expect(pair(port)).resolves.toHaveProperty('id');
  });

  it('answers requests from this machine in full and tailnet peers with the server version only', async () => {
    const port = await start();
    const local = await fetch(`http://127.0.0.1:${port}/health`);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      server: 'stim-server',
      name: 'Test Mac',
      version: '1.2.3',
      stim: '9.9.9',
      stimBuild: expect.stringMatching(/^[0-9a-f]{16}$/),
      protocol: 2,
      stimHome: process.env.STIM_HOME,
      startup: { state: 'ready' },
      busy: { builds: 0, hostedSessions: 0, hostedWork: 0, tests: 0, resumes: true },
      tailscale: { state: 'not-running', backendState: 'Stopped' },
      nativeViewerOpened: false,
      keepAwake: { setting: false, held: false, reason: 'off' },
      workerRoot: null,
    });
    const forwarded = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '100.64.0.2' } });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual({ version: '1.2.3' });
    const fromPage = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-forwarded-for': '100.64.0.2', origin: 'http://attacker.example' },
    });
    expect(fromPage.status).toBe(426);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/health', headers: { host: `attacker.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(rebound).toBe(426);
  });

  test.skipIf(!fakeTailscale)(
    'refuses the agent route to web pages and unknown sessions and never answers it as a WebSocket upgrade page',
    async () => {
      const port = await start();
      const session = '11111111-1111-4111-8111-111111111111';
      const agent = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/device-host/agent/${session}/rpc`, { method: 'POST', body: '{}', headers });
      expect((await agent({})).status).toBe(404);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', origin: 'http://attacker.example' })).status).toBe(403);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await agent({ 'x-forwarded-for': '100.64.0.2', authorization: 'Bearer nothing' })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/device-host/agent/not-a-session/rpc`)).status).toBe(426);
    },
  );

  it('follows Tailscale coming up and going away after start', async () => {
    let next: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
    const initial = { binary: null, state: next };
    const monitor = watchTailscale({
      env: {},
      initial,
      find: () => 'tailscale',
      read: async () => next,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ tailscaleState: initial.state, tailscaleMonitor: monitor });
    const health = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { tailscale: unknown }).tailscale;
    const eventually = async (done: () => boolean | Promise<boolean>) => {
      for (let attempt = 0; attempt < 200 && !(await done()); attempt++) await new Promise((r) => setTimeout(r, 10));
      expect(await done()).toBe(true);
    };
    expect(await health()).toEqual({ state: 'unavailable', reason: 'it timed out' });
    expect(server!.addresses).toHaveLength(1);
    next = { state: 'running', ips: ['::1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };
    await eventually(() => server!.addresses.length === 2);
    expect(server!.addresses[1]).toEqual({ host: '::1', port });
    expect(await health()).toEqual({ state: 'running', dnsName: 'mac.tail1.ts.net' });
    const tailnetClient = await openRaw(`ws://[::1]:${port}`);
    const dropped = new Promise((resolve) => tailnetClient.once('close', resolve));
    next = { state: 'not-running', backendState: 'Stopped' };
    await eventually(() => server!.addresses.length === 1);
    await dropped;
    expect(await health()).toEqual({ state: 'not-running', backendState: 'Stopped' });
    monitor.stop();
  });

  it('listens on the bind addresses of a transport that never reports a change', async () => {
    const port = await start({
      transports: [
        {
          id: 'static',
          bindAddresses: () => ['::1'],
        },
      ],
    });
    expect(server?.addresses).toEqual([
      { host: '127.0.0.1', port },
      { host: '::1', port },
    ]);
  });

  describe('keep awake', () => {
    function holders() {
      const spawned: FakeHolder[] = [];
      const spawnHolder = () => {
        const holder = new FakeHolder(7000 + spawned.length);
        spawned.push(holder);
        return holder;
      };
      return { spawned, spawnHolder };
    }
    function remoteTransport(initial: string[]) {
      const state = { addresses: initial, listeners: new Set<(event: { addresses: string[] }) => void>() };
      const transport: Transport = {
        id: 'static',
        bindAddresses: () => state.addresses,
        watch: (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
      };
      const change = (addresses: string[]) => {
        state.addresses = addresses;
        for (const listener of state.listeners) listener({ addresses });
      };
      return { transport, change };
    }
    const eventually = async (done: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise((r) => setTimeout(r, 10));
      expect(done()).toBe(true);
    };
    const keepAwakeHealth = async (port: number) => {
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      return isJsonObject(body) ? body.keepAwake : undefined;
    };

    it('holds the assertion while the setting is on and a listener for other machines is up, and releases it with either', async () => {
      const { spawned, spawnHolder } = holders();
      const remote = remoteTransport(['::1']);
      const setting = { on: true, listeners: new Set<() => void>() };
      const port = await start({
        transports: [remote.transport],
        keepAwake: {
          setting: () => setting.on,
          onChange: (listener) => {
            setting.listeners.add(listener);
            return () => setting.listeners.delete(listener);
          },
          platform: 'darwin',
          spawnHolder,
        },
      });
      expect(spawned).toHaveLength(1);
      expect(await keepAwakeHealth(port)).toEqual({ setting: true, held: true, pid: 7000 });

      remote.change([]);
      await eventually(() => spawned[0]?.stopped === true);
      expect(await keepAwakeHealth(port)).toEqual({ setting: true, held: false, reason: 'not-listening' });

      remote.change(['::1']);
      await eventually(() => spawned.length === 2);
      setting.on = false;
      for (const listener of setting.listeners) listener();
      expect(spawned[1]?.stopped).toBe(true);
      expect(await keepAwakeHealth(port)).toEqual({ setting: false, held: false, reason: 'off' });
    });

    it('releases the assertion when the server closes', async () => {
      const { spawned, spawnHolder } = holders();
      await start({
        transports: [remoteTransport(['::1']).transport],
        keepAwake: { setting: () => true, platform: 'darwin', spawnHolder },
      });
      expect(spawned).toHaveLength(1);
      await server?.close();
      expect(spawned[0]?.stopped).toBe(true);
    });

    it('never holds it for a loopback-only server, whatever the transports and setting say', async () => {
      const { spawned, spawnHolder } = holders();
      const port = await start({
        loopbackOnly: true,
        transports: [remoteTransport(['::1']).transport],
        keepAwake: { setting: () => true, platform: 'darwin', spawnHolder },
      });
      expect(spawned).toEqual([]);
      expect(await keepAwakeHealth(port)).toEqual({ setting: true, held: false, reason: 'loopback-only' });
    });
  });

  it('reports Tailscale but never listens on its addresses when loopback only', async () => {
    const running: TailscaleState = { state: 'running', ips: ['::1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };
    const monitor = watchTailscale({
      env: {},
      initial: { binary: 'tailscale', state: running },
      find: () => 'tailscale',
      read: async () => running,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ loopbackOnly: true, tailscaleState: running, tailscaleMonitor: monitor });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server!.addresses).toEqual([{ host: '127.0.0.1', port }]);
    monitor.stop();
  });

  it('listens again on a Tailscale address that failed to bind', async () => {
    let next: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
    const monitor = watchTailscale({
      env: {},
      initial: { binary: null, state: next },
      find: () => 'tailscale',
      read: async () => next,
      backoffMs: 10,
      maxMs: 20,
    });
    const port = await start({ tailscaleState: next, tailscaleMonitor: monitor, listenRetryMs: 20 });
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(port, '::1', resolve));
    try {
      next = { state: 'running', ips: ['::1'], dnsName: null, hostName: null };
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(server!.addresses).toHaveLength(1);
      await new Promise((resolve) => blocker.close(resolve));
      for (let attempt = 0; attempt < 200 && server!.addresses.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server!.addresses).toEqual([
        { host: '127.0.0.1', port },
        { host: '::1', port },
      ]);
    } finally {
      monitor.stop();
      blocker.close();
    }
  });

  test.skipIf(!fakeTailscale)('reports the current tailscale serve route to the server', async () => {
    const serveStatus = join(root, 'serve.json');
    writeFileSync(serveStatus, '{}');
    const port = await start({
      tailscaleState: { state: 'running', ips: [], dnsName: 'mac.tail1.ts.net', hostName: 'mac' },
      env: { FAKE_SERVE_STATUS: serveStatus },
    });
    const route = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { route: unknown }).route;
    expect(await route()).toEqual({ state: 'missing', port: 7443 });
    writeFileSync(
      serveStatus,
      JSON.stringify({
        TCP: { '7443': { HTTPS: true } },
        Web: { 'mac.tail1.ts.net:7443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
      }),
    );
    expect(await route()).toEqual({ state: 'routed', port: 7443 });
  });
});

describe('unauthenticated connections', () => {
  it('refuses requests before hello', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    expect(await client.request('machine.subscribe')).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await client.closed).toBe(4401);
    expect(readdirSync(root)).not.toContain('pids');
  });

  it('closes a silent connection after the timeout and rate-limits repeated failures by peer', async () => {
    const port = await start({ authTimeoutMs: 100, maxAuthFailures: 2 });
    const silent = await openPlain(port, '100.64.0.2');
    expect(await silent.closed).toBe(4408);
    const stranger = await connect(port, '100.64.0.2');
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });

    await expect(openPlain(port, '100.64.0.2')).rejects.toThrow('HTTP 429');
    const otherPeer = await openPlain(port, '100.64.0.3');
    expect(otherPeer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('lets a requester poll with a setup ticket the server does not hold yet without being rate limited', async () => {
    const port = await start({ maxAuthFailures: 2 });
    const ticket = newSecret();
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(connect(port, '100.64.0.2', { secret: ticket })).rejects.toMatchObject({ code: 'unknown-secret' });
    }
    storeSetupSecret(Buffer.from(ticket, 'base64url'), ['build'], new Date(Date.now() + 60_000).toISOString());
    const client = await connect(port, '100.64.0.2', { secret: ticket });
    expect(await client.request('hello', { client: CLIENT, access: 'build' })).toHaveProperty('result.capabilities', [
      'build',
    ]);
  });

  it('turns away an address that names unknown setup tickets far faster than any requester polls', async () => {
    const port = await start({ maxUnknownSecrets: 3 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(connect(port, '100.64.0.2', { secret: newSecret() })).rejects.toMatchObject({
        code: 'unknown-secret',
      });
    }
    await expect(openPlain(port, '100.64.0.2')).rejects.toThrow('HTTP 429');
    const otherPeer = await openPlain(port, '100.64.0.3');
    expect(otherPeer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses a web page before it can spend the failed-attempt budget of this machine', async () => {
    const port = await start({ authTimeoutMs: 100, maxAuthFailures: 2 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(openPlain(port, undefined, { origin: 'https://attacker.example' })).rejects.toThrow('HTTP 403');
    }
    await expect(pair(port)).resolves.toHaveProperty('id');
  });

  it('survives a peer that resets the connection after a refused upgrade', async () => {
    const port = await start({ loopbackOnly: true });
    assert(server);
    const running = server;
    const upgradeRequest = (headers: string) =>
      `GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`;
    const resetAfterRefusal = (headers: string) =>
      new Promise<void>((resolve) => {
        const refused = connectNet({ port, host: '127.0.0.1' });
        refused.once('connect', () => refused.write(upgradeRequest(headers)));
        refused.once('data', () => {
          refused.resetAndDestroy();
          resolve();
        });
      });
    const closeBeforeRefusal = (headers: string) =>
      new Promise<void>((resolve) => {
        const [inside, refused] = duplexPair();
        running.acceptLocal(inside);
        refused.write(upgradeRequest(headers), () => {
          refused.destroy();
          resolve();
        });
      });
    const uncaught: Error[] = [];
    const record = (error: Error) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      await resetAfterRefusal('X-Forwarded-For: 100.64.0.2\r\n');
      await resetAfterRefusal('Origin: https://attacker.example\r\n');
      await closeBeforeRefusal('Origin: https://attacker.example\r\n');
      for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      process.off('uncaughtException', record);
    }
    expect(uncaught).toEqual([]);
  });
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (info) =>
      info?.family === 'IPv4' && !info.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(info.address),
  )?.address;

describe.skipIf(!lanIp)('the local network listener', () => {
  const host = lanIp ?? '';
  const lan = () => [localTransport({ entries: () => [host] })];
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
  });
  const raw = (port: number) =>
    new Promise<{ socket: Socket; closed: Promise<void> }>((resolve, reject) => {
      const socket = connectNet(port, host);
      sockets.push(socket);
      const closed = once(socket, 'close').then(() => undefined);
      socket.once('connect', () => resolve({ socket, closed }));
      socket.once('error', reject);
    });
  const stillOpen = (closed: Promise<void>) =>
    Promise.race([closed.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 300))]);

  it('holds a bounded number of unauthenticated connections per address, and an authenticated one stops counting', async () => {
    const port = await start({ transports: lan(), pendingConnections: { max: 8, perPeer: 2 } });
    expect(server?.addresses.map((address) => address.host)).toContain(host);
    const first = await raw(port);
    const second = await raw(port);
    const refused = await raw(port);
    await refused.closed;
    expect(await stillOpen(second.closed)).toBe(true);

    first.socket.destroy();
    await first.closed;
    const { token } = createPairingToken(Date.now(), capabilitiesFor(false));
    const phone = await noiseConnect(`ws://${host}:${port}`, { secret: token });
    expect(await phone.request('hello', { client: CLIENT })).toHaveProperty('result.device');
    const third = await raw(port);
    expect(await stillOpen(third.closed)).toBe(true);
    const over = await raw(port);
    await over.closed;
    phone.socket.close();
  });

  const second = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === 'IPv4' && !info.internal && info.address !== lanIp)?.address;

  it('keeps a flood on one network address from starving connections to another', async ({ skip }) => {
    if (!second) return skip('this machine has one private network address');
    const other = second;
    const both: Transport = {
      id: 'both',
      bindAddresses: () => [host, other],
    };
    const port = await start({ transports: [both], pendingConnections: { max: 2, perPeer: 2 } });
    await raw(port);
    await raw(port);
    const refused = await raw(port);
    await refused.closed;
    const elsewhere = await new Promise<{ socket: Socket; closed: Promise<void> }>((resolve, reject) => {
      const socket = connectNet(port, other);
      sockets.push(socket);
      const closed = once(socket, 'close').then(() => undefined);
      socket.once('connect', () => resolve({ socket, closed }));
      socket.once('error', reject);
    });
    expect(await stillOpen(elsewhere.closed)).toBe(true);
  });

  it('closes a connection that sends no request in time', async () => {
    const port = await start({ transports: lan(), headersTimeoutMs: 200 });
    const silent = await raw(port);
    await expect(silent.closed).resolves.toBeUndefined();
  });

  it('turns agent control requests away before any transport identifies the peer', async () => {
    let identified = 0;
    const counting: Transport = {
      id: 'counting',
      identify: async () => {
        identified++;
        return null;
      },
    };
    const port = await start({ transports: [...lan(), counting] });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`http://${host}:${port}/device-host/agent/${randomUUID()}/status`);
      expect(response.status).toBe(404);
    }
    expect(identified).toBe(0);
  });

  it('refuses a key it has no record for, and tells a peer only its version', async () => {
    const port = await start({ transports: lan() });
    const stranger = await noiseConnect(`ws://${host}:${port}`);
    expect(await stranger.closedWith).toEqual({ code: 4401, reason: 'unauthorized' });
    const peer = await fetch(`http://${host}:${port}/health`);
    expect(await peer.json()).toEqual({ version: '1.2.3' });
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({
      lan: { addresses: [host], port },
    });
  });
});

describe('upgradeFromWebPage', () => {
  it.each<[string, 'local' | 'proxied' | 'direct', Record<string, string>, boolean]>([
    ['Desktop or the CLI on loopback', 'local', { host: '127.0.0.1:7787' }, false],
    ['a simulator app on loopback', 'local', { host: '127.0.0.1:7787', origin: 'http://127.0.0.1:7787' }, false],
    ['an app on localhost', 'local', { host: 'localhost:7787', origin: 'http://localhost:7787' }, false],
    ['an app on IPv6 loopback', 'local', { host: '[::1]:7787', origin: 'http://[::1]:7787' }, false],
    ['a cross-site page on loopback', 'local', { host: '127.0.0.1:7787', origin: 'https://attacker.example' }, true],
    ['a page on another local port', 'local', { host: '127.0.0.1:7787', origin: 'http://127.0.0.1:8081' }, true],
    ['a DNS-rebound page', 'local', { host: 'attacker.example:7787', origin: 'http://attacker.example:7787' }, true],
    ['an https origin on loopback', 'local', { host: '127.0.0.1:7787', origin: 'https://127.0.0.1:7787' }, true],
    ['an opaque origin', 'local', { host: '127.0.0.1:7787', origin: 'null' }, true],
    ['an origin without a host', 'local', { origin: 'http://127.0.0.1:7787' }, true],
    ['a loopback browser fetch', 'local', { host: '127.0.0.1:7787', 'sec-fetch-site': 'same-origin' }, true],
    ['the CLI over the tailnet', 'proxied', { host: 'mac.tail.ts.net:7443' }, false],
    [
      'a phone over the tailnet',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net:7443' },
      false,
    ],
    ['an iOS phone on port 443', 'proxied', { host: 'mac.tail.ts.net:443', origin: 'https://mac.tail.ts.net' }, false],
    [
      'an Android phone on port 443',
      'proxied',
      { host: 'mac.tail.ts.net', origin: 'https://mac.tail.ts.net:443' },
      false,
    ],
    ['a phone on an IPv6 address', 'proxied', { host: '[fd7a::1]:7443', origin: 'https://[fd7a::1]:7443' }, false],
    [
      'a page on another tailnet host',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://evil.example' },
      true,
    ],
    ['a page on another IPv6 host', 'proxied', { host: '[fd7a::1]:7443', origin: 'https://[fd7a::2]:7443' }, true],
    ['a page on another port', 'proxied', { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net' }, true],
    ['an http origin over the tailnet', 'proxied', { host: '100.64.0.1:7787', origin: 'http://100.64.0.1:7787' }, true],
    [
      'a same-origin browser fetch over the tailnet',
      'proxied',
      { host: 'mac.tail.ts.net:7443', origin: 'https://mac.tail.ts.net:7443', 'sec-fetch-site': 'same-origin' },
      true,
    ],
    ['the CLI on a local network address', 'direct', { host: '10.0.0.92:7787' }, false],
    [
      'a phone straight to a tailnet address',
      'direct',
      { host: '100.64.0.1:7787', origin: 'http://100.64.0.1:7787' },
      false,
    ],
    [
      'a phone on a local network address',
      'direct',
      { host: '10.0.0.92:7787', origin: 'http://10.0.0.92:7787' },
      false,
    ],
    [
      'a DNS-rebound page on a local network address',
      'direct',
      { host: 'attacker.example:7787', origin: 'http://attacker.example:7787' },
      true,
    ],
    [
      'a page on another local network host',
      'direct',
      { host: '10.0.0.92:7787', origin: 'http://10.0.0.5:7787' },
      true,
    ],
    [
      'an https origin on a local network address',
      'direct',
      { host: '10.0.0.92:7787', origin: 'https://10.0.0.92:7787' },
      true,
    ],
  ])('%s', (_name, via, headers, refused) => {
    expect(upgradeFromWebPage(headers, via)).toBe(refused);
  });
});

describe('a client that leaves during the handshake', () => {
  test.skipIf(!fakeTailscale)('keeps the pairing token and starts no status child', async () => {
    const port = await start({ whoisDelayMs: 300 });
    const { token } = createPairingToken();
    const leaving = await connect(port, '100.64.0.2', { secret: token });
    leaving.socket.send(JSON.stringify({ id: 1, method: 'hello', params: { client: CLIENT } }));
    leaving.socket.send(JSON.stringify({ id: 2, method: 'machine.subscribe' }));
    leaving.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(readDevices()).toEqual([]);
    expect(readdirSync(root)).not.toContain('pids');
    const retry = await connect(port, '100.64.0.2', { secret: token });
    expect(await retry.request('hello', { client: CLIENT })).toHaveProperty('result.device.id');
  });
});

describe('status feed lifecycle', () => {
  it('shares one status watch across subscribers and stops it with the last one', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const first = await returning(port, keyPair);
    expect(await first.request('machine.subscribe')).toEqual({ id: 2, result: { subscription: 's1' } });
    expect(await first.next()).toMatchObject({
      event: 'machine',
      subscription: 's1',
      seq: 0,
      machine: { capacity: { live: 0 } },
    });
    expect(await first.next()).toMatchObject({
      event: 'machine',
      subscription: 's1',
      seq: 1,
      machine: { capacity: { live: 1 } },
    });

    await until(() => statusWorkers().length === 1);

    const second = await returning(port, keyPair);
    await second.request('machine.subscribe');
    expect(await second.next()).toMatchObject({
      event: 'machine',
      subscription: 's1',
      seq: 0,
      machine: { capacity: { live: 1 } },
    });
    expect(await second.request('machine.subscribe')).toMatchObject({ result: { subscription: 's2' } });
    expect(await second.next()).toMatchObject({
      event: 'machine',
      subscription: 's2',
      seq: 0,
      machine: { capacity: { live: 1 } },
    });
    expect(statusWorkers()).toHaveLength(1);

    expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
    expect(await first.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(statusWorkers()).toHaveLength(1);

    second.socket.close();
    await until(() => statusWorkers().length === 0, 1000);
    expect(stimCalls().map((call) => call.args)).toContain('status-worker stop');
  });

  it('starts the status watch when the server becomes ready, before any subscriber, and keeps it', async () => {
    const port = await start({ statusAtBoot: true });
    await until(() => statusWorkers().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const client = await authed(port);
    await client.request('machine.subscribe');
    expect(await client.next()).toMatchObject({
      event: 'machine',
      subscription: 's1',
      seq: 0,
      machine: { capacity: { live: 1 } },
    });
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(statusWorkers()).toHaveLength(1);
  });

  it('stops the status watch when the server closes', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    await client.request('machine.subscribe');
    await client.next();
    await until(() => statusWorkers().length === 1);

    await server!.close();
    forgetServer();
    await until(() => statusWorkers().length === 0, 1000);
    expect(statusWorkers()).toEqual([]);
  });

  it('sends CPU and memory history with the machine view once a payload reports owners', async () => {
    const machine = {
      memorySource: 'footprint',
      owners: [
        {
          kind: 'simulator',
          name: 'sim',
          workspace: '/work/app',
          id: 'UDID-1',
          owned: true,
          cpuPercent: 12.5,
          residentMb: 3000,
          memoryMb: 1500,
          processes: 40,
        },
      ],
    };
    const port = await start({ env: { FAKE_STIM_PAYLOADS: JSON.stringify([{ ...PAYLOADS[1], machine }]) } });
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    await client.request('machine.subscribe');
    const event = (await client.next()) as MachineEvent;
    expect(event.machine.machine).toEqual(machine);
    expect(event.usage).toMatchObject({
      intervalMs: 15_000,
      devices: [{ kind: 'simulator', id: 'UDID-1', workspace: '/work/app' }],
    });
    const [app] = event.usage!.environments;
    expect(app).toMatchObject({ workspace: '/work/app' });
    expect(app!.cpuPercent).toHaveLength(40);
    expect(app!.cpuPercent.filter((value) => value !== null)).toEqual([12.5]);
    expect(app!.memoryMb.filter((value) => value !== null)).toEqual([1500]);
  });

  it('ends the subscription with an error event when the status watch exits', async () => {
    const port = await start({ exit: true });
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    await client.request('machine.subscribe');
    await client.next();
    await client.next();
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'status-failed', message: 'the status worker exited (code 3)' },
    });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });
});

describe('status views', () => {
  const machine = { capacity: { live: 0 }, deviceLeases: [], simctlAvailable: true, machine: null };
  const app = (overrides: Record<string, unknown> = {}) => ({
    path: '/work/app',
    live: true,
    warnings: [],
    issues: [],
    memoryMb: 0,
    logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 0 },
    ...overrides,
  });
  const other = { path: '/work/other', live: false, warnings: [], issues: [], memoryMb: 0 };
  const archive = (id: string, removedAt: string) => ({
    id,
    projectRoot: `/work/${id}`,
    project: id,
    workspace: `${id}--0`,
    worktree: {},
    removedAt,
    removedBy: 'gc',
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 0, recordings: 0, agentActions: 0, record: 1, total: 1 },
    expires: {},
    version: 1,
  });
  const archived = [
    archive('a', '2026-10-01T00:00:00.000Z'),
    archive('b', '2026-10-03T00:00:00.000Z'),
    archive('c', '2026-10-02T00:00:00.000Z'),
  ];
  const payload = (environments: unknown[], extra: Record<string, unknown> = {}) => ({
    ...machine,
    environments,
    unprovisionedWorktrees: [{ path: '/work/loose', branch: 'loose', repository: '/work', git: null }],
    archived,
    archivedUsage: { count: 3, bytes: 3, byKind: { logs: 0, recordings: 0, agentActions: 0, record: 3 } },
    ...extra,
  });
  const sequence = [
    payload([app(), other]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } }), other]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } })]),
    payload([app({ logs: { dir: '/home/.stim/workspaces/app/logs', errorsSinceMarker: 2 } })]),
  ];
  const startViews = () => start({ env: { FAKE_STIM_PAYLOADS: JSON.stringify(sequence) } });

  it('sends the workspace list once, then only the workspaces that changed or went away', async () => {
    const client = await authed(await startViews());
    expect(await client.request('status.subscribe')).toMatchObject({ error: { code: 'unknown-method' } });
    expect(await client.request('workspaces.subscribe')).toMatchObject({ result: { subscription: 's1' } });
    const first = (await client.next()) as WorkspacesEvent;
    expect(first).toMatchObject({ event: 'workspaces', subscription: 's1', seq: 0 });
    const snapshot = first.snapshot;
    assert(snapshot);
    expect(snapshot.workspaces.map((summary) => summary.path)).toEqual(['/work/app', '/work/other']);
    expect(snapshot.workspaces[0]?.logs).toEqual({ errorsSinceMarker: 0 });
    expect(snapshot.worktrees).toEqual([{ path: '/work/loose', branch: 'loose', repository: '/work', git: null }]);
    expect(snapshot.archived).toEqual({
      count: 3,
      bytes: 3,
      newest: ['b', 'c', 'a'].map((id) => ({
        id,
        projectRoot: `/work/${id}`,
        project: id,
        workspace: `${id}--0`,
        removedAt: archived.find((each) => each.id === id)?.removedAt,
      })),
    });
    expect(await client.next()).toEqual({
      event: 'workspaces',
      subscription: 's1',
      seq: 1,
      workspaces: {
        upsert: [expect.objectContaining({ path: '/work/app', logs: { errorsSinceMarker: 2 } })],
        remove: [],
      },
    });
    expect(await client.next()).toEqual({
      event: 'workspaces',
      subscription: 's1',
      seq: 2,
      workspaces: { upsert: [], remove: ['/work/other'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
  });

  it('sends one workspace whole, again only when it changes, and null once it is gone', async () => {
    const client = await authed(await startViews());
    await client.request('workspace.subscribe', { workspace: '/work/other' });
    expect(await client.next()).toEqual({ event: 'workspace', subscription: 's1', seq: 0, environment: other });
    expect(await client.next()).toEqual({ event: 'workspace', subscription: 's1', seq: 1, environment: null });
    expect(await client.request('workspace.subscribe', {})).toMatchObject({ error: { code: 'bad-request' } });
  });

  it('sends the machine view without the workspaces', async () => {
    const client = await authed(await startViews());
    await client.request('machine.subscribe');
    expect(await client.next()).toEqual({
      event: 'machine',
      subscription: 's1',
      seq: 0,
      machine: { ...machine, maintenance: null, daemon: null },
    });
  });

  it('reads build history, archives a page at a time, worktrees and maintenance on request', async () => {
    const builds = { ios: [{ platform: 'ios', status: 'ok', startedAt: '2026-10-01T00:00:00.000Z' }] };
    const port = await start({
      env: { FAKE_STIM_PAYLOADS: JSON.stringify([payload([app({ builds })], { maintenance: { mode: 'off' } })]) },
    });
    const client = await authed(port);
    expect(await client.request('builds.history', { workspace: '/work/app' })).toMatchObject({ result: { builds } });
    expect(await client.request('builds.history', { workspace: '/work/nope' })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    const first = (await client.request('archived.list', { limit: 2 })) as { result: ArchivedListResult };
    expect(first.result.archived.map((each) => each.id)).toEqual(['b', 'c']);
    expect(first.result.usage).toMatchObject({ count: 3 });
    const second = (await client.request('archived.list', { limit: 2, before: first.result.next })) as {
      result: ArchivedListResult;
    };
    expect(second.result.archived.map((each) => each.id)).toEqual(['a']);
    expect(second.result.next).toBeNull();
    expect(await client.request('worktrees.list')).toMatchObject({
      result: { worktrees: [{ path: '/work/loose', git: null }] },
    });
    expect(await client.request('maintenance.get')).toMatchObject({ result: { maintenance: { mode: 'off' } } });
  });
});

describe('push.register', () => {
  const PUSH = {
    token: 'ExponentPushToken[abc123]',
    events: ['stuck', 'machine'],
    levels: { stuck: 'silent', machine: 'alert' },
    ref: 'mac-1',
    stuckMinutes: 20,
    quietHours: { start: 22 * 60, end: 7 * 60, timeZone: 'America/Toronto' },
  };

  it('stores the registration with the pairing and keeps the status watch until it is removed', async () => {
    const port = await start();
    const { keyPair } = await pair(port);
    const client = await returning(port, keyPair);
    expect(await client.request('push.register', PUSH)).toEqual({ id: 2, result: {} });
    expect(readDevices()[0]!.push).toMatchObject(PUSH);
    await until(() => statusWorkers().length === 1);

    client.socket.close();
    await client.closed;
    expect(statusWorkers()).toHaveLength(1);

    const again = await returning(port, keyPair);
    expect(await again.request('push.unregister')).toEqual({ id: 2, result: {} });
    expect(readDevices().every((device) => !device.push)).toBe(true);
    await until(() => statusWorkers().length === 0, 1000);
  });

  it('moves a token registered from a new pairing of the same phone off the old pairing', async () => {
    const port = await start();
    const first = await authed(port);
    await first.request('push.register', PUSH);
    const second = await authed(port);
    await second.request('push.register', PUSH);
    expect(readDevices().map((device) => device.push?.token)).toEqual([undefined, PUSH.token]);
  });

  it.each([false, true])('drops a revoked push registration with watch events dropped: %s', async (dropEvents) => {
    registryWatch.dropEvents = dropEvents;
    const port = await start();
    const client = await authed(port);
    await client.request('push.register', PUSH);
    await until(() => statusWorkers().length === 1);
    revokeDevice(readDevices()[0]!.id);
    expect(readDevices()).toEqual([]);
    await until(() => statusWorkers().length === 0, 1000);
  });

  it('refuses a token that is not an Expo push token and unknown events', async () => {
    const port = await start();
    const client = await authed(port);
    for (const params of [
      { ...PUSH, token: 'https://example.com/hook' },
      { ...PUSH, events: ['offline'] },
      { ...PUSH, events: [] },
      { ...PUSH, ref: '' },
      { ...PUSH, agentOnly: 'yes' },
      { ...PUSH, stuckMinutes: 0 },
      { ...PUSH, stuckMinutes: 2.5 },
      { ...PUSH, quietHours: { start: 1440, end: 0, timeZone: 'UTC' } },
      { ...PUSH, quietHours: { start: 0, end: 60, timeZone: 'Mars/Olympus' } },
      { ...PUSH, levels: { stuck: 'loud' } },
      { ...PUSH, levels: { offline: 'alert' } },
      { ...PUSH, levels: ['silent'] },
    ]) {
      expect(await client.request('push.register', params)).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(readDevices()[0]!.push).toBeUndefined();
  });
});

describe('workspace diff reads', () => {
  it('serves a registered worktree to a read-only paired phone without exposing another directory', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, 'new.txt'), 'new text\n');
    const client = await authed(await start());
    expect(await client.request('workspace.files', { workspace, group: 'untracked' })).toMatchObject({
      result: { files: [{ path: 'new.txt', untracked: true }], truncated: false },
    });
    expect(await client.request('workspace.diff', { workspace, path: 'new.txt' })).toMatchObject({
      result: { path: 'new.txt', patches: [{ section: 'untracked', kind: 'text', text: 'new text\n' }] },
    });
    expect(await client.request('workspace.files', { workspace: root, group: 'changed' })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(await client.request('workspace.diff', { workspace, path: '../secret' })).toMatchObject({
      error: { code: 'stim-failed' },
    });
    expect(await client.request('workspace.files', { workspace })).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('workspace.diff', { workspace, path: 'new.txt', command: 'add' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('refuses a connection that has no read grant before any diff read', async () => {
    const client = await connect(await start(), undefined, {
      secret: createPairingToken(Date.now(), ['control']).token,
    });
    await client.request('hello', { client: CLIENT });
    expect(await client.request('workspace.files', { workspace, group: 'changed' })).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});

describe('logs.query', () => {
  it('reads the workspace in process with the Desktop viewer filters', async () => {
    liveLogFixture([
      { ts: 1, src: 'device', marker: true, platform: 'ios', slot: 'tablet' },
      { ts: 2, src: 'metro', level: 'error', msg: '-render failure' },
      { ts: 3, src: 'client', level: 'warn', msg: '-render warning' },
      { ts: 4, src: 'client', level: 'error', msg: '-render error', slot: 'tablet' },
    ]);
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('logs.query', {
      workspace,
      sources: ['client', 'metro'],
      level: 'warn',
      slot: 'tablet',
      grep: '-render',
      errors: true,
      tail: 50,
    });
    expect(reply).toEqual({
      id: 2,
      result: {
        records: [
          { ts: 2, src: 'metro', level: 'error', msg: '-render failure' },
          { ts: 4, src: 'client', level: 'error', msg: '-render error', slot: 'tablet' },
        ],
      },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
  });

  it('refuses an unregistered workspace and invalid filters without running stim', async () => {
    liveLogFixture();
    const port = await start();
    const client = await authed(port);
    const other = join(root, 'other');
    mkdirSync(other);
    if (process.platform === 'win32')
      writeFileSync(join(root, 'tailscale.cmd'), `@"${process.execPath}" "%~dp0tailscale" %*\r\n`);
    expect(await client.request('logs.query', { workspace: other })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const filter of [
      { tail: 5001 },
      { sources: ['nope'] },
      { sources: [] },
      { grep: '(' },
      { grep: 'a\0b' },
      { slot: 'tab\0let' },
      { slot: '--errors' },
      { level: 'loud' },
    ]) {
      for (const method of ['logs.query', 'logs.subscribe']) {
        expect(await client.request(method, { workspace, ...filter })).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
    }
    expect(await client.request('logs.query', { workspace })).toMatchObject({ result: { records: RECORDS } });
    expect(await client.request('logs.subscribe', { workspace: other })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
  });
});

function archiveFixture(logged: unknown[] = []): { id: string; dir: string } {
  const removedAt = '2026-10-01T12:00:00Z';
  const id = `${workspaceName(workspace)}--${Date.parse(removedAt)}`;
  const dir = archiveDir(id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const archive: ArchivedWorkspace = {
    id,
    projectRoot: workspace,
    project: 'app',
    workspace: workspaceName(workspace),
    worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    removedAt,
    removedBy: 'worktree-remove',
    lastUsedAt: null,
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 0, recordings: 0, agentActions: 0, record: 0, total: 0 },
    expires: { logs: null, recordings: null, agentActions: null, record: null },
    version: 1,
  };
  writeFileSync(join(dir, 'archive.json'), JSON.stringify(archive));
  writeFileSync(join(dir, 'logs', 'client.ndjson'), logged.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { id, dir };
}

function archivedFootage(dir: string, first: number, count: number, platform: 'ios' | 'android' = 'ios'): void {
  const device = join(dir, 'recordings', recordingDeviceName(platform, 'default'));
  mkdirSync(device, { recursive: true });
  const units = Array.from({ length: count }, (_, i) => {
    const header = Buffer.alloc(17);
    header.writeUInt32BE(18, 0);
    header.writeUInt8(i % 5 === 0 ? 1 : 0, 4);
    header.writeDoubleBE(first + i * 100, 5);
    header.writeUInt16BE(330, 13);
    header.writeUInt16BE(720, 15);
    return Buffer.concat([header, Buffer.from([0, 0, 0, 1, i])]);
  });
  writeFileSync(join(device, closedSegmentName(first, first + (count - 1) * 100)), Buffer.concat(units));
}

describe('archive.detail', () => {
  it('returns the archive build history in live shape and closed spans for every recording slot', async () => {
    const { id, dir } = archiveFixture();
    const startedAt = '2026-10-01T11:00:00Z';
    const common = {
      startedAt,
      cacheSkipped: false,
      fingerprint: 'native-key',
      slot: 'default',
      configuration: 'Debug',
      cacheKey: 'native-key',
    };
    const failed = {
      ...common,
      platform: 'ios',
      status: 'failed',
      result: 'failed',
      cacheHit: false,
      durationMs: 5000,
      phases: { prepare: 1000, compile: 4000 },
      errorCode: 'STIM_BUILD_FAILED',
      diagnostics: [{ file: 'App.swift', line: 12, column: 3, message: 'Missing symbol' }],
    };
    const succeeded = {
      ...common,
      platform: 'android',
      status: 'ok',
      result: 'succeeded',
      cacheHit: 'remote',
      slot: 'fold',
      configuration: 'debug',
      durationMs: 3000,
      phases: { 'cache-lookup': 1000, install: 2000 },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ buildHistory: { ios: [failed], android: [succeeded] } }));
    mkdirSync(workspaceStateDir(workspace), { recursive: true });
    writeFileSync(join(workspaceStateDir(workspace), 'state.json'), JSON.stringify({ buildHistory: {} }));
    const recordings = join(dir, 'recordings');
    for (const [device, segments] of Object.entries({
      'ios-default': ['1000-2000.seg', '2200-3000.seg', '6000-7000.seg', '8000.part'],
      'ios-tablet': ['4000-5000.seg'],
      'android-fold': ['10000-11000.seg'],
      'web-desktop': ['12000-13000.seg'],
      'android-empty': ['14000.part'],
    })) {
      mkdirSync(join(recordings, device), { recursive: true });
      for (const segment of segments) writeFileSync(join(recordings, device, segment), 'listing only');
    }
    symlinkSync(join(recordings, 'ios-default'), join(recordings, 'ios-link'), 'dir');
    symlinkSync(join(recordings, 'ios-default', '1000-2000.seg'), join(recordings, 'ios-default', '15000-16000.seg'));
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const expected = {
      builds: {
        ios: [{ ...failed, finishedAt: '2026-10-01T11:00:05.000Z' }],
        android: [{ ...succeeded, finishedAt: '2026-10-01T11:00:03.000Z' }],
      },
      recordings: [
        { platform: 'android', slot: 'fold', spans: [{ start: 10000, end: 11000 }] },
        {
          platform: 'ios',
          slot: 'default',
          spans: [
            { start: 1000, end: 3000 },
            { start: 6000, end: 7000 },
          ],
        },
        { platform: 'ios', slot: 'tablet', spans: [{ start: 4000, end: 5000 }] },
        { platform: 'web', slot: 'desktop', spans: [{ start: 12000, end: 13000 }] },
      ],
    };
    const reply = await client.request('archive.detail', { archive: id });
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const detail = reply.result as ArchiveDetailResult;
    expect({
      ...detail,
      recordings: detail.recordings.toSorted((a, b) =>
        `${a.platform}-${a.slot}`.localeCompare(`${b.platform}-${b.slot}`),
      ),
    }).toEqual(expected);
    expect(stimCalls()).toEqual([]);
    rmSync(recordings, { recursive: true });
    symlinkSync(root, recordings, 'dir');
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({ result: { recordings: [] } });
  });

  it('refuses unknown archives and symlinked archive paths with unknown-workspace', async () => {
    const { id, dir } = archiveFixture();
    symlinkSync(dir, archiveDir('linked'), 'dir');
    const client = await authed(await start());
    for (const archive of ['missing', 'linked']) {
      expect(await client.request('archive.detail', { archive })).toMatchObject({
        error: { code: 'unknown-workspace' },
      });
    }
    const record = join(dir, 'archive.json');
    cpSync(record, join(root, 'archive.json'));
    rmSync(record);
    symlinkSync(join(root, 'archive.json'), record);
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    for (const params of [
      {},
      { workspace },
      { workspace, archive: id },
      { archive: '../outside' },
      { archive: '' },
      { archive: 1 },
    ]) {
      expect(await client.request('archive.detail', params)).toMatchObject({ error: { code: 'bad-request' } });
    }
  });

  it('returns empty builds when archived state is missing or unreadable', async () => {
    const { id, dir } = archiveFixture();
    const client = await authed(await start());
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      result: { builds: {}, recordings: [] },
    });
    for (const state of [
      'not json',
      JSON.stringify({ lastBuild: { platform: 'ios' } }),
      JSON.stringify({ buildHistory: {} }),
    ]) {
      writeFileSync(join(dir, 'state.json'), state);
      expect(await client.request('archive.detail', { archive: id })).toMatchObject({
        result: { builds: {}, recordings: [] },
      });
    }
    rmSync(join(dir, 'state.json'));
    writeFileSync(
      join(root, 'state.json'),
      JSON.stringify({ buildHistory: { ios: [{ platform: 'ios', status: 'ok', startedAt: '2026-10-01T11:00:00Z' }] } }),
    );
    symlinkSync(join(root, 'state.json'), join(dir, 'state.json'));
    expect(await client.request('archive.detail', { archive: id })).toMatchObject({
      result: { builds: {}, recordings: [] },
    });
  });
});

describe('archived reads', () => {
  it('merges archived agent-device sessions into queries, subscriptions and replay markers', async () => {
    const { id, dir } = archiveFixture();
    cpSync(
      join(import.meta.dirname, '../../stim-cli/src/__tests__/fixtures/agent-device/sessions'),
      join(dir, 'agent-device', 'sessions'),
      { recursive: true },
    );
    const base = Date.parse('2026-09-25T12:12:00Z');
    archivedFootage(dir, base, 10);
    archivedFootage(dir, Date.parse('2026-09-13T01:56:00Z'), 10, 'android');
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const queried = await client.request('logs.query', { archive: id, sources: ['agent'] });
    expect(queried).toMatchObject({
      result: {
        records: expect.arrayContaining([
          {
            ts: Date.parse('2026-09-25T12:16:03.448Z'),
            startedAt: Date.parse('2026-09-25T12:15:57.453Z'),
            src: 'agent',
            level: 'info',
            event: 'agent_action',
            session: 'cwd:b764dacffe51e890:default',
            platform: 'ios',
            deviceId: 'AD45387C-599D-4EDB-A62B-18176FF3A2A7',
            command: 'press',
            msg: 'Tapped (201, 542)',
            details: {
              command: 'press',
              positionals: ['<arg>'],
              targetLabel: '(201, 542)',
              selectorChainLength: 2,
              x: 201,
              y: 542,
            },
          },
          expect.objectContaining({ platform: 'android', event: 'agent_failed', msg: 'Failed open: DEVICE_NOT_FOUND' }),
        ]),
      },
    });
    expect(await client.request('logs.query', { archive: id })).toMatchObject({
      result: (queried as { result: unknown }).result,
    });
    await client.request('logs.subscribe', { archive: id, sources: ['agent'] });
    expect(await client.next()).toMatchObject({ event: 'logs', ...(queried as { result: object }).result });
    expect(await client.next()).toMatchObject({ event: 'logs-ended' });
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: {
        markers: expect.arrayContaining([
          { at: Date.parse('2026-09-25T12:15:57.453Z'), kind: 'action', command: 'press', label: 'Tapped (201, 542)' },
          {
            at: Date.parse('2026-09-25T12:16:03.541Z'),
            kind: 'action',
            command: 'press',
            label: 'Failed press: COMMAND_FAILED',
          },
        ]),
      },
    });
    expect(await client.request('replay.range', { archive: id, platform: 'android' })).toMatchObject({
      result: {
        markers: expect.arrayContaining([
          {
            at: Date.parse('2026-09-13T01:56:45.575Z'),
            kind: 'action',
            command: 'open',
            label: 'Failed open: DEVICE_NOT_FOUND',
          },
          { at: Date.parse('2026-09-13T01:58:25.718Z'), kind: 'action', command: 'press', label: 'Tapped (541, 2265)' },
        ]),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('bounds pending archive reads and releases their request slots', async () => {
    const { id, dir } = archiveFixture();
    archivedFootage(dir, 1000, 10);
    const client = await authed(await start());
    const params = { archive: id, platform: 'ios', at: 1000, video: ['h264'] };
    const methods = [
      'logs.query',
      'logs.subscribe',
      'replay.range',
      'archive.detail',
      'replay.keyframe',
      'frames.subscribe',
    ];
    const replies = await Promise.all(
      Array.from({ length: 120 }, (_, index) => client.request(methods[index % methods.length]!, params)),
    );
    const refused = replies.filter((reply) => 'error' in reply);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused).toSatisfy((all: unknown[]) =>
      all.every(
        (reply) =>
          (reply as { error: { code: string } }).error.code === 'limit-exceeded' &&
          (reply as { error: { message: string } }).error.message === 'A connection can run 32 requests at a time.',
      ),
    );
    expect(await client.request('frames.subscribe', params)).toMatchObject({ result: { video: 'h264' } });
    expect(await client.request('logs.query', { archive: id })).toMatchObject({ result: { records: [] } });
  });

  it('queries real archived logs with the same JSON filters and context as the CLI', async () => {
    const { id, dir } = archiveFixture([
      { ts: 2, src: 'client', level: 'error', msg: 'previous error' },
      { ts: 5, src: 'build', level: 'info', marker: true, platform: 'ios', slot: 'tablet', msg: 'launched' },
      { ts: 8, src: 'client', level: 'error', msg: 'current error' },
      { ts: 9, src: 'device', level: 'fatal', event: 'native_crash', platform: 'ios', slot: 'tablet', msg: 'crash' },
      { ts: 11, src: 'agent', level: 'info', platform: 'ios', slot: 'tablet', event: 'agent_action', msg: 'press' },
    ]);
    writeFileSync(
      join(dir, 'logs', 'metro.ndjson.1'),
      JSON.stringify({ ts: 1, src: 'metro', level: 'warn', msg: 'rotated' }) + '\n',
    );
    writeFileSync(
      join(dir, 'logs', 'metro.ndjson'),
      [
        { ts: 6, src: 'metro', level: 'info', marker: true, msg: 'iOS Bundled' },
        { ts: 7, src: 'metro', level: 'error', raw: true, event: 'metro_stderr', msg: 'Unable to resolve module' },
        { ts: 10, src: 'metro', level: 'info', raw: true, event: 'metro_stderr', msg: 'Code: app.ts' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    const liveLogs = join(workspaceStateDir(workspace), 'logs');
    cpSync(join(dir, 'logs'), liveLogs, { recursive: true });
    const cli = new URL('../../stim-cli/dist/cli.mjs', import.meta.url);
    const cases = [
      { filter: {}, args: [] },
      {
        filter: { sources: ['metro'], level: 'warn', grep: 'rotated|resolve', tail: 2 },
        args: ['--source=metro', '--level=warn', '--grep=rotated|resolve', '--tail=2'],
      },
      { filter: { errors: true, tail: 3 }, args: ['--errors', '--tail=3'] },
      { filter: { slot: 'tablet', errors: true }, args: ['--slot=tablet', '--errors'] },
      { filter: { sources: ['agent'], slot: 'tablet' }, args: ['--source=agent', '--slot=tablet'] },
    ];
    const client = await authed(await start());
    const queried: unknown[][] = [];
    for (const { filter, args } of cases) {
      const expected = execFileSync(process.execPath, [fileURLToPath(cli), 'logs', '--json', '--tail=5000', ...args], {
        cwd: workspace,
        env: { ...process.env, STIM_DAEMON: 'off' },
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(await client.request('logs.query', { archive: id, ...filter })).toMatchObject({
        result: { records: expected },
      });
      queried.push(expected);
    }
    expect(queried[2]).toContainEqual(expect.objectContaining({ context: ['Code: app.ts'] }));
    expect(queried[3]).toContainEqual(expect.objectContaining({ context: ['Code: app.ts'] }));
    rmSync(workspace, { recursive: true });
    writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ projects: {} }));
    expect(await client.request('logs.query', { archive: id, sources: ['agent'] })).toMatchObject({
      result: { records: [expect.objectContaining({ msg: 'press' })] },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('batches archived records, ends once, and releases even empty subscriptions', async () => {
    const logged = Array.from({ length: 501 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: `record ${ts}` }));
    const { id, dir } = archiveFixture(logged);
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    expect(await client.request('logs.subscribe', { archive: id })).toMatchObject({ result: { subscription: 's1' } });
    expect(await client.next()).toEqual({ event: 'logs', subscription: 's1', records: logged.slice(0, 500) });
    expect(await client.next()).toEqual({ event: 'logs', subscription: 's1', records: logged.slice(500) });
    expect(await client.next()).toEqual({ event: 'logs-ended', subscription: 's1' });
    for (let i = 1; i < 33; i++) {
      const subscription = `s${i + 1}`;
      expect(await client.request('logs.subscribe', { archive: id, grep: 'absent' })).toMatchObject({
        result: { subscription },
      });
      expect(await client.next()).toEqual({ event: 'logs-ended', subscription });
    }
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(readdirSync(join(dir, 'logs'))).toEqual(['client.ndjson']);
    expect(stimCalls()).toEqual([]);
  });

  it('reports overflow instead of successful completion', async () => {
    const { id } = archiveFixture(
      Array.from({ length: 3 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'record' })),
    );
    const client = await authed(await start({ logLimits: { maxPendingRecords: 2 } }));
    await client.request('logs.subscribe', { archive: id });
    expect(await client.next()).toMatchObject({ event: 'error', subscription: 's1', error: { code: 'slow-client' } });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('rejects ambiguous targets, traversal, unknown archives, symlinks and malformed records', async () => {
    const { id, dir } = archiveFixture();
    const link = `${id}-link`;
    symlinkSync(dir, archiveDir(link), 'dir');
    mkdirSync(archiveDir('broken'));
    writeFileSync(join(archiveDir('broken'), 'archive.json'), '{}');
    const client = await authed(await start());
    for (const method of ['logs.query', 'logs.subscribe', 'replay.range', 'replay.keyframe', 'frames.subscribe']) {
      const rest = { platform: 'ios', at: 1, video: ['h264'] };
      for (const target of [
        {},
        { workspace, archive: id },
        { archive: '../outside' },
        { archive: 'a/b' },
        { archive: 'a\\b' },
        { archive: '..' },
        { archive: '' },
        { archive: 1 },
        { archive: 'a\0b' },
      ]) {
        expect(await client.request(method, { ...rest, ...target })).toMatchObject({ error: { code: 'bad-request' } });
      }
      for (const archive of ['missing', link, 'broken']) {
        expect(await client.request(method, { ...rest, archive })).toMatchObject({
          error: { code: 'unknown-workspace', message: expect.stringContaining(archive) },
        });
      }
    }
    expect(stimCalls()).toEqual([]);
  });

  it('serves spans, markers and keyframes from archives without touching a replacement workspace', async () => {
    const base = Date.now() - 60_000;
    const { id, dir } = archiveFixture([
      {
        ts: base + 300,
        startedAt: base + 200,
        src: 'agent',
        level: 'info',
        event: 'agent_action',
        platform: 'ios',
        command: 'press',
        msg: 'press @e3',
      },
      {
        ts: base + 400,
        src: 'agent',
        level: 'info',
        event: 'agent_action',
        platform: 'android',
        command: 'press',
        msg: 'other',
      },
      { ts: base + 30_500, src: 'build', level: 'error', msg: 'Compile failed' },
    ]);
    archivedFootage(dir, base, 10);
    archivedFootage(dir, base + 30_000, 10);
    const client = await authed(await start());
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: {
        enabled: false,
        recording: false,
        spans: [
          { start: base, end: base + 900 },
          { start: base + 30_000, end: base + 30_900 },
        ],
        markers: [
          { at: base + 200, kind: 'action', command: 'press', label: 'press @e3' },
          { at: base + 30_500, kind: 'error', label: 'Compile failed' },
        ],
      },
    });
    rmSync(workspace, { recursive: true });
    expect(await client.request('replay.keyframe', { archive: id, platform: 'ios', at: base + 850 })).toMatchObject({
      result: {
        start: base,
        end: base + 900,
        at: base,
        width: 330,
        height: 720,
        data: Buffer.from([0, 0, 0, 1, 0]).toString('base64'),
      },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('replays and seeks archived frames locally and refuses live and physical subscriptions', async () => {
    const base = Date.now() - 60_000;
    const { id, dir } = archiveFixture();
    archivedFootage(dir, base, 10);
    rmSync(workspace, { recursive: true });
    const client = await authed(await start());
    const target = { archive: id, platform: 'ios', video: ['h264'] };
    expect(await client.request('frames.subscribe', target)).toMatchObject({ error: { code: 'bad-request' } });
    expect(await client.request('frames.subscribe', { ...target, at: base, physical: true })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(await client.request('frames.subscribe', { ...target, at: base + 230 })).toMatchObject({
      result: { subscription: 's1', video: 'h264' },
    });
    const capturedAt = async () => {
      const message = await client.next();
      expect(message).toHaveProperty('binary');
      return (message as unknown as { binary: Buffer }).binary.readDoubleBE(8);
    };
    expect(await capturedAt()).toBe(base);
    expect(await capturedAt()).toBe(base + 100);
    expect(await capturedAt()).toBe(base + 200);
    expect(await client.request('frames.seek', { subscription: 's1', at: base + 730, rate: 0 })).toMatchObject({
      result: { at: base + 700 },
    });
    expect(await capturedAt()).toBe(base + 500);
    expect(await capturedAt()).toBe(base + 600);
    expect(await capturedAt()).toBe(base + 700);
    expect(await client.request('frames.live', { subscription: 's1' })).toMatchObject({
      error: { code: 'frames-failed', message: expect.stringContaining(id) },
    });
    expect(await client.request('frames.seek', { subscription: 's1', at: base + 900, rate: 2 })).toMatchObject({
      result: { at: base + 900 },
    });
    for (const offset of [500, 600, 700, 800, 900]) expect(await capturedAt()).toBe(base + offset);
    expect(await client.next()).toEqual({ event: 'replay-ended', subscription: 's1', at: base + 900 });
    expect(stimCalls()).toEqual([]);
  });

  it('returns empty ranges and no-recording for archives without closed footage', async () => {
    const { id, dir } = archiveFixture();
    const device = join(dir, 'recordings', recordingDeviceName('ios', 'default'));
    mkdirSync(device, { recursive: true });
    writeFileSync(join(device, '1000.part'), Buffer.alloc(17));
    const client = await authed(await start());
    expect(await client.request('replay.range', { archive: id, platform: 'ios' })).toMatchObject({
      result: { enabled: false, recording: false, spans: [], markers: [] },
    });
    expect(await client.request('replay.keyframe', { archive: id, platform: 'ios', at: 1000 })).toMatchObject({
      error: { code: 'no-recording' },
    });
    expect(
      await client.request('frames.subscribe', { archive: id, platform: 'ios', video: ['h264'], at: 1000 }),
    ).toMatchObject({ error: { code: 'no-recording' } });
    expect(existsSync(join(device, '1000.part'))).toBe(true);
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop build logs', () => {
  it('streams complete retained build output only to the proved Desktop without overflowing its pending limit', async () => {
    const retained = Array.from({ length: 6001 }, (_, index) => ({
      ts: Math.floor(index / 3) + 1,
      src: 'build',
      level: 'info',
      msg: `build-${index}`,
      ...(index % 2 ? { slot: 'second', platform: 'ios' } : {}),
    }));
    const path = liveLogFixture(retained);
    const port = await start({ logLimits: { maxBufferedBytes: 64 * 1024, maxPendingRecords: 200 } });
    const remote = await authed(port, true);
    expect(await remote.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    expect(await plain.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    const client = await desktop();
    for (const extra of [{ tail: 1 }, { sources: ['unknown'] }, { slot: 'second' }, { archive: 'archive' }]) {
      expect(await client.request('desktop.logs.subscribe', { workspace, ...extra })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
    expect(await client.request('desktop.logs.subscribe', { workspace: root })).toMatchObject({
      error: { code: 'unknown-workspace' },
    });
    expect(await client.request('desktop.logs.subscribe', { workspace })).toMatchObject({
      result: { subscription: 's1' },
    });
    expect(await records(client, retained.length)).toEqual(retained);
    const next = { ts: 3000, src: 'build', level: 'info', msg: 'appended' };
    appendFileSync(path, JSON.stringify(next) + '\n');
    expect(await records(client, 1)).toEqual([next]);
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
    expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
    expect(childPids()).toEqual([]);
  });
});

describe('logs.subscribe', () => {
  it('backfills the requested tail and follows appends independently for each subscriber', async () => {
    const path = liveLogFixture();
    const port = await start();
    const first = await authed(port);
    const second = await authed(port);
    vi.useFakeTimers();
    try {
      expect(await first.request('logs.subscribe', { workspace, tail: 2 })).toEqual({
        id: 2,
        result: { subscription: 's1' },
      });
      const firstTail = records(first, 2);
      await vi.waitFor(() => expect(firstTail).resolves.toEqual(RECORDS.slice(1)));
      await second.request('logs.subscribe', { workspace, tail: 1 });
      const secondTail = records(second, 1);
      await vi.waitFor(() => expect(secondTail).resolves.toEqual(RECORDS.slice(2)));
      const appended = { ts: 4, src: 'client', level: 'info', msg: 'new line' };
      const firstAppend = records(first, 1);
      const secondAppend = records(second, 1);
      appendFileSync(path, JSON.stringify(appended) + '\n');
      await vi.advanceTimersByTimeAsync(10100);
      await vi.waitFor(() => expect(firstAppend).resolves.toEqual([appended]));
      await vi.waitFor(() => expect(secondAppend).resolves.toEqual([appended]));
      expect(await first.request('unsubscribe', { subscription: 's1' })).toEqual({ id: 3, result: {} });
      const later = { ts: 5, src: 'client', level: 'info', msg: 'after unsubscribe' };
      const secondLater = records(second, 1);
      appendFileSync(path, JSON.stringify(later) + '\n');
      await vi.advanceTimersByTimeAsync(10100);
      await vi.waitFor(() => expect(secondLater).resolves.toEqual([later]));
      second.socket.close();
      expect(stimCalls().filter((call) => call.args.startsWith('logs'))).toEqual([]);
      expect(childPids()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out an unfinished backfill and keeps another socket responsive', async () => {
    liveLogFixture(
      Array.from({ length: 100_000 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'x'.repeat(300) })),
    );
    const port = await start({ commandLimits: { timeoutMs: 5 } });
    const slow = await authed(port);
    const other = await authed(port);
    await slow.request('logs.subscribe', { workspace });
    expect(await other.request('hello', { client: CLIENT })).toHaveProperty('error.code', 'already-authenticated');
    expect(await slow.next()).toMatchObject({
      event: 'error',
      subscription: 's1',
      error: { code: 'logs-failed', message: expect.stringContaining('did not finish') },
    });
    expect(await slow.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('drops a backfill exceeding the pending limit and releases its subscription', async () => {
    liveLogFixture(Array.from({ length: 500 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'line' })));
    const port = await start({ logLimits: { maxBufferedBytes: 64 * 1024, maxPendingRecords: 200 } });
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    expect(await client.next()).toMatchObject({ event: 'error', subscription: 's1', error: { code: 'slow-client' } });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
  });

  it('stops an in-flight backfill when its last subscriber leaves or the server closes', async () => {
    liveLogFixture(Array.from({ length: 100_000 }, (_, ts) => ({ ts, src: 'client', level: 'info', msg: 'line' })));
    const port = await start();
    const client = await authed(port);
    await client.request('logs.subscribe', { workspace });
    expect(await client.request('unsubscribe', { subscription: 's1' })).toMatchObject({ result: {} });
    await client.request('logs.subscribe', { workspace });
    await server!.close();
    forgetServer();
    expect(childPids()).toEqual([]);
  });
});

describe('machine.get', () => {
  it('reports the volumes holding Stim state, merged per volume, without running stim', async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('machine.get');
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const usage = reply.result as MachineUsage;
    const shared = usage.volumes.find((v) => v.holds.includes('Stim home'));
    expect(shared?.holds).toContain('Workspaces');
    expect(usage.volumes.filter((v) => v.holds.includes('Workspaces'))).toHaveLength(1);
    expect(shared!.freeBytes).toBeGreaterThan(0);
    expect(shared!.freeBytes).toBeLessThanOrEqual(shared!.totalBytes);
    expect(usage.memory.totalBytes).toBe(totalmem());
    expect(usage.load.cpus).toBeGreaterThan(0);
    expect(stimCalls()).toEqual([]);
  });
});

describe('machine.history', () => {
  it('refuses a non-numeric sinceMs', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('machine.history', { sinceMs: 'soon' })).toMatchObject({
      error: { code: 'bad-request' },
    });
  });
});

describe('machine.details', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('shares the home stats read and gc dry run between read-only phones within a minute', async () => {
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
      },
    });
    const first = await authed(port);
    const second = await authed(port);
    const expected = {
      gc: expect.objectContaining({ mode: 'dry-run', sections: expect.any(Object) }),
      stats: readStatsReport(null, Date.now()).report,
      buildMachines: [],
      buildClients: [],
      measuredAt: expect.any(String),
    };
    const reply = await first.request('machine.details');
    expect(reply).toEqual({ id: 2, result: expected });
    expect(await second.request('machine.details')).toEqual(reply);
    expect(
      stimCalls()
        .map((call) => call.args)
        .toSorted(),
    ).toEqual([]);
  });

  it('answers immediately with pending remote machines, then reads them from doctor in the background', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    for (const project of [workspace, other]) writeFileSync(join(project, 'package.json'), '{"private":true}');
    const ran = (at: string) => ({ doctorRuns: { ios: { at, version: '1.0.0' } } });
    writeFileSync(
      join(process.env.STIM_HOME!, 'config.json'),
      JSON.stringify({
        remote: { machines: ['mini'] },
        projects: {
          [workspace]: ran('2026-09-28T10:00:00.000Z'),
          [other]: ran('2026-09-28T11:00:00.000Z'),
          [join(root, 'gone')]: ran('2026-09-28T12:00:00.000Z'),
        },
      }),
    );
    const port = await start({
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: [root, dirname(process.execPath)].join(delimiter),
        STIM_DAEMON: 'off',
        FAKE_TAILSCALE_CWDS: join(root, 'doctor-cwds'),
      },
    });
    const client = await authed(port);
    const first = await client.request('machine.details');
    expect(first).toMatchObject({ result: { buildMachines: null, buildMachinesPending: true } });

    let reply: unknown;
    for (let i = 0; i < 50; i++) {
      reply = await client.request('machine.details');
      if (!(reply as { result: { buildMachinesPending?: boolean } }).result.buildMachinesPending) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reply).toMatchObject({
      result: {
        buildMachines: [{ machine: 'mini', state: 'tailscale-off' }],
        buildMachinesAt: expect.any(String),
      },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toEqual([]);
    expect([...new Set(readFileSync(join(root, 'doctor-cwds'), 'utf8').trim().split('\n'))]).toEqual([other]);

    expect(await client.request('machine.details')).toMatchObject({
      result: { buildMachines: [{ machine: 'mini', state: 'tailscale-off' }] },
    });
    expect(stimCalls().filter((call) => call.args.startsWith('doctor'))).toEqual([]);
  });

  it('keeps the stats when gc fails, and says why gc is missing', async () => {
    const port = await start({
      commandLimits: { maxOutputBytes: 1 },
      env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' },
    });
    const client = await authed(port);
    expect(await client.request('machine.details')).toMatchObject({
      result: {
        gc: null,
        gcError: 'stim gc printed more than 1 bytes.',
        stats: { version: 1, machine: { ios: null, android: null } },
      },
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('machine.get on macOS', () => {
  it("reports the machine's memory used below its total", async () => {
    const port = await start();
    const client = await authed(port);
    const reply = await client.request('machine.get');
    if (!('result' in reply)) throw new Error(JSON.stringify(reply));
    const { memory } = reply.result as MachineUsage;
    expect(memory.usedBytes).toBeGreaterThan(0);
    expect(memory.usedBytes).toBeLessThan(memory.totalBytes);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop settings', () => {
  it('serves its settings registry schema only through the authenticated Desktop boundary', async () => {
    const port = await start();
    const remote = await authed(port);
    expect(await remote.request('desktop.settings.schema')).toHaveProperty('error.code', 'forbidden');
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    expect(await plain.request('desktop.settings.schema')).toHaveProperty('error.code', 'forbidden');
    const client = await desktop();
    for (const params of [null, { cwd: workspace }]) {
      expect(await client.request('desktop.settings.schema', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(await client.request('desktop.settings.schema')).toEqual({
      id: expect.any(Number),
      result: settingsJsonSchema(),
    });
    expect(await client.request('desktop.settings.schema', {})).toEqual({
      id: expect.any(Number),
      result: settingsJsonSchema(),
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reads fresh masked settings for an unregistered selected folder only through the Desktop boundary', async () => {
    const selected = join(root, 'selected');
    mkdirSync(selected);
    writeFileSync(join(selected, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }));
    const committed = join(selected, '.stim.json');
    writeFileSync(
      committed,
      JSON.stringify({ optimizations: { buildCache: false }, android: { keystorePassword: 'env:STIM_3484_SECRET' } }),
    );
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), archive: { maxCount: 7 } }));
    const port = await start({ env: { STIM_TMPDIR: join(root, 'fast') } });
    const before = readFileSync(config, 'utf8');
    const remote = await authed(port);
    expect(await remote.request('desktop.settings.get', { cwd: selected })).toHaveProperty('error.code', 'forbidden');
    expect(await remote.request('settings.get', { workspace: selected })).toHaveProperty(
      'error.code',
      'unknown-workspace',
    );
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    expect(await plain.request('desktop.settings.get', { cwd: selected })).toHaveProperty('error.code', 'forbidden');
    const client = await desktop();
    for (const params of [undefined, null, {}, { cwd: 'relative' }, { cwd: selected, workspace: selected }]) {
      expect(await client.request('desktop.settings.get', params)).toHaveProperty('error.code', 'bad-request');
    }
    const result = await client.request('desktop.settings.get', { cwd: selected });
    expect(result).toMatchObject({
      result: {
        project: selected,
        files: { machine: config, committed },
        settings: expect.arrayContaining([
          { key: 'optimizations.buildCache', value: false, origin: 'committed', layers: { committed: false } },
          {
            key: 'android.keystorePassword',
            value: '********',
            origin: 'committed',
            layers: { committed: '********' },
            sensitive: true,
          },
          expect.objectContaining({ key: 'tempDir', value: join(root, 'fast'), origin: 'env' }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('STIM_3484_SECRET');
    writeFileSync(committed, JSON.stringify({ optimizations: { buildCache: true } }));
    expect(await client.request('desktop.settings.get', { cwd: selected })).toMatchObject({
      result: {
        settings: expect.arrayContaining([
          { key: 'optimizations.buildCache', value: true, origin: 'committed', layers: { committed: true } },
        ]),
      },
    });
    expect(await client.request('desktop.settings.get', { cwd: root })).toMatchObject({
      result: {
        project: null,
        settings: expect.arrayContaining([
          { key: 'archive.maxCount', value: 7, origin: 'machine', layers: { machine: 7 } },
        ]),
      },
    });
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(stimCalls()).toEqual([]);
  });
});

describe('action', () => {
  it('stops the registered workspace without a CLI and keeps the CLI JSON output and audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    const reply = await client.request('action', { action: 'stop', workspace });
    expect(readWorkspaceState(workspace)?.launches).toBeUndefined();
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../stim-cli/dist/cli.mjs', import.meta.url)), 'stop', '--json'],
        { cwd: workspace, env: process.env, encoding: 'utf8' },
      ),
    );
    expect(reply).toEqual({ id: expect.any(Number), result: { action: 'stop', workspace, output } });
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([
      expect.objectContaining({ action: 'stop', workspace, ok: true, durationMs: expect.any(Number) }),
    ]);
  });

  function holdConfigDuringStop() {
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const lock = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' }).acquired;
    assert(lock);
    return lock;
  }

  test.skipIf(process.platform === 'win32')(
    'answers another client while an Android stop waits for its device probe',
    async () => {
      const sdk = join(root, 'sdk');
      const bin = join(root, 'bin');
      const avds = join(root, 'avds');
      const avd = 'stim-delayed-fixture';
      const entered = join(root, 'probe-entered');
      const released = join(root, 'probe-released');
      const finished = join(root, 'probe-finished');
      mkdirSync(join(sdk, 'emulator'), { recursive: true });
      mkdirSync(join(sdk, 'platform-tools'));
      mkdirSync(join(avds, `${avd}.avd`), { recursive: true });
      writeFileSync(join(avds, `${avd}.ini`), `path=${join(avds, `${avd}.avd`)}\n`);
      mkdirSync(bin);
      const emulator = join(sdk, 'emulator', 'emulator');
      const adb = join(sdk, 'platform-tools', 'adb');
      const agent = join(bin, 'agent-device');
      writeFileSync(emulator, `#!${process.execPath}\nconsole.log(${JSON.stringify(avd)});\n`);
      writeFileSync(agent, `#!${process.execPath}\nconsole.log(JSON.stringify({success:true,data:{sessions:[]}}));\n`);
      writeFileSync(
        adb,
        `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(entered)}, '');
const deadline = Date.now() + 2000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(released)}) && Date.now() < deadline) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(finished)}, '');
  console.log('List of devices attached');
}, 10);
`,
      );
      for (const tool of [emulator, adb, agent]) chmodSync(tool, 0o755);
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({
          projects: { [workspace]: { platforms: { android: { avdName: avd, owned: true } } } },
        }),
      );
      writeFileSync(
        join(root, 'home', 'created-devices.json'),
        JSON.stringify({ version: 1, ios: [], android: [avd], web: [] }),
      );
      const port = await start({
        env: { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avds, PATH: `${bin}:${process.env.PATH}` },
      });
      const client = await authed(port, true);
      const other = await authed(port, true);
      rmSync(join(root, 'fake-stim.mjs'));
      const stopping = client.request('action', { action: 'stop', workspace });
      try {
        await until(() => existsSync(entered));
        expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
        expect(existsSync(finished)).toBe(false);
        writeFileSync(released, '');
        expect(await stopping).toMatchObject({ result: { action: 'stop', output: { ok: true } } });
        expect(stimCalls()).toEqual([]);
      } finally {
        writeFileSync(released, '');
        await stopping;
      }
    },
    15_000,
  );

  it('retains an unverifiable supervisor and reports a failed stop without running a CLI', async () => {
    const config = join(root, 'home', 'config.json');
    writeFileSync(config, JSON.stringify({ projects: { [workspace]: { supervisor: { pid: process.pid } } } }));
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('unverified') },
    });
    expect(JSON.parse(readFileSync(config, 'utf8')).projects[workspace].supervisor.pid).toBe(process.pid);
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([expect.objectContaining({ action: 'stop', ok: false })]);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports the storage failure when a stop cannot update registration',
    async () => {
      const state = workspaceStateDir(workspace);
      mkdirSync(state, { recursive: true });
      const port = await start();
      const client = await authed(port, true);
      const home = join(root, 'home');
      rmSync(join(root, 'fake-stim.mjs'));
      chmodSync(home, 0o500);
      try {
        expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
          error: { code: 'action-failed', message: expect.stringContaining('EACCES') },
        });
        expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).projects[workspace]).toBeDefined();
        expect(stimCalls()).toEqual([]);
      } finally {
        chmodSync(home, 0o700);
        await createStim({ projectRoot: workspace, home }).stop();
      }
    },
  );

  it('bounds the in-process stop response by the existing action output limit', async () => {
    const port = await start({ actionLimits: { maxOutputBytes: 8 } });
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'action-failed', message: 'stim stop printed more than 8 bytes.' },
    });
    expect(stimCalls()).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'reaps a SIGTERM-ignoring stop probe before server shutdown completes',
    async () => {
      const bin = join(root, 'probe-bin');
      mkdirSync(bin);
      const entered = join(root, 'probe-started');
      const escaped = join(root, 'probe-escaped');
      const probe = join(bin, 'lsof');
      writeFileSync(
        probe,
        `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(escaped)}, ''); process.exit(0); }, 15000);
`,
      );
      chmodSync(probe, 0o755);
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: { metroPort: 8083 } } }),
      );
      const port = await start({ env: { PATH: `${bin}:${process.env.PATH}` }, actionLimits: { timeoutMs: 500 } });
      const client = await authed(port, true);
      const other = await authed(port, true);
      const stopping = client.request('action', { action: 'stop', workspace });
      let owned: { pid: number; processToken: string } | undefined;
      try {
        const pid = await readPid(entered);
        const processToken = captureProcessToken(pid);
        assert(processToken);
        owned = { pid, processToken };
        expect(await stopping).toMatchObject({ error: { code: 'action-failed' } });
        expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
        assert(server);
        await server.close();
        forgetServer();
        expect(existsSync(escaped)).toBe(false);
        expect(alive(await readPid(entered))).toBe(false);
      } finally {
        if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
        await stopping;
      }
    },
    25_000,
  );

  it('drains a timed-out stop at shutdown while a foreign status response keeps streaming', async () => {
    let escaped = false;
    const listener = createHttpServer((_request, response) => {
      response.write('packager-status:running');
      const chunks = setInterval(() => response.write('.'), 20);
      const escape = setTimeout(() => {
        escaped = true;
        response.end();
      }, 3000);
      response.once('close', () => {
        clearInterval(chunks);
        clearTimeout(escape);
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, 'localhost', resolve));
    try {
      const address = listener.address();
      assert(address && typeof address === 'object');
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: { metroPort: address.port } } }),
      );
      const port = await start({ actionLimits: { timeoutMs: 500 } });
      const client = await authed(port, true);
      expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
        error: { code: 'action-failed' },
      });
      assert(server);
      await server.close();
      forgetServer();
      expect(escaped).toBe(false);
      expect(listener.listening).toBe(true);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('keeps a timed-out stop busy until cleanup drains and waits for it at server shutdown', async () => {
    const port = await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await authed(port, true);
    const other = await authed(port, true);
    const lock = holdConfigDuringStop();
    let released = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = client.request('action', { action: 'stop', workspace });
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      expect(await reply).toMatchObject({
        error: { code: 'action-failed', message: 'stim stop did not finish within 1 s.' },
      });
      expect(await other.request('action', { action: 'reload', workspace })).toMatchObject({
        error: { code: 'action-busy' },
      });
      release = setTimeout(() => {
        released = true;
        releaseClaim(lock);
      }, 50);
      const active = server;
      if (!active) throw new Error('Server was not started.');
      await active.close();
      forgetServer();
      expect(released).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      clearTimeout(release);
      releaseClaim(lock);
      await createStim({ projectRoot: workspace, home: join(root, 'home') }).stop();
    }
  });

  it('keeps an in-process stop running after its requesting client disconnects', async () => {
    const port = await start();
    const client = await authed(port, true);
    const other = await authed(port, true);
    const lock = holdConfigDuringStop();
    try {
      client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'stop', workspace } }));
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      client.socket.terminate();
      await client.closed;
      expect(await other.request('machine.history')).toMatchObject({ result: expect.anything() });
      expect(readAudit()).toEqual([]);
      releaseClaim(lock);
      await until(() => readAudit().some((record) => record.action === 'stop' && record.ok));
      expect(stimCalls()).toEqual([]);
    } finally {
      releaseClaim(lock);
      await createStim({ projectRoot: workspace, home: join(root, 'home') }).stop();
    }
  });

  it('refuses a read-only device, runs nothing, and audits the refusal', async () => {
    const port = await start();
    const client = await authed(port);
    expect(await client.request('action', { action: 'stop', workspace })).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('--control') },
    });
    expect(stimCalls()).toEqual([]);
    expect(readAudit()).toEqual([
      expect.objectContaining({
        device: { id: readDevices()[0]!.id, name: 'Test phone' },
        action: 'stop',
        workspace,
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' }),
      }),
    ]);
  });

  it('advertises the actions to a control device and stops honoring them once the machine takes control back', async () => {
    const port = await start();
    const { id, keyPair } = await pair(port, undefined, true);
    const client = await connect(port, undefined, { keyPair });
    expect(await client.request('hello', { client: CLIENT })).toMatchObject({
      result: { capabilities: ['read', 'control'], actions: ['reload', 'stop'] },
    });
    expect(grantDevice(id, capabilitiesFor(false))).toBe('granted');
    expect(await client.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(stimCalls()).toEqual([]);
  });

  it('refuses unknown actions, invalid params and workspaces the server does not list, running nothing', async () => {
    const port = await start();
    const client = await authed(port, true);
    const refusals = [
      [{ action: 'gc', workspace }, 'unknown-action'],
      [{ action: 'reload --delete', workspace }, 'unknown-action'],
      ['stop', 'bad-request'],
      [{ action: 'stop' }, 'bad-request'],
      [{ action: 'stop', workspace, platform: 'ios' }, 'bad-request'],
      [{ action: 'stop', workspace, args: ['--delete'] }, 'bad-request'],
      [{ action: 'reload', workspace, platform: '--help' }, 'bad-request'],
      [{ action: 'stop', workspace: join(root, 'other') }, 'unknown-workspace'],
      [{ action: 'stop', workspace: `${workspace}/` }, 'unknown-workspace'],
      [{ action: 'stop', workspace: `${workspace}/../app` }, 'unknown-workspace'],
    ] as const;
    for (const [params, code] of refusals) {
      expect(await client.request('action', params)).toMatchObject({ error: { code } });
    }
    expect(stimCalls()).toEqual([]);
    expect(readAudit().map((record) => record.error?.code)).toEqual(refusals.map(([, code]) => code));

    await client.request('action', { action: 'x'.repeat(10_000), workspace: 'y'.repeat(10_000) });
    const long = readAudit().at(-1)!;
    expect([long.action!.length, long.workspace!.length, long.error!.message.length]).toEqual([256, 256, 256]);
  });

  it('frees the workspace when the command cannot start', async () => {
    const file = join(root, 'not-a-dir');
    writeFileSync(file, '');
    writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ projects: { [file]: {} } }));
    const port = await start();
    const client = await authed(port, true);
    for (let i = 0; i < 2; i++) {
      expect(await client.request('action', { action: 'stop', workspace: file })).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('could not start') },
      });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'runs an action for the Unix socket connection, which holds control without a pairing',
    async () => {
      const browser = await reloadBrowser();
      await start();
      const local = await desktop();
      expect(await local.request('action', { action: 'reload', workspace })).toMatchObject({
        result: { action: 'reload', workspace },
      });
      expect(browser.methods.filter((method) => method === 'Page.reload')).toEqual(['Page.reload']);
      expect(stimCalls()).toEqual([]);
    },
  );

  it('reloads the owned page in process and audits the requested platform', async () => {
    const browser = await reloadBrowser();
    const port = await start();
    const client = await authed(port, true);
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('action', { action: 'reload', workspace, platform: 'web' })).toEqual({
      id: 2,
      result: {
        action: 'reload',
        workspace,
        output: {
          platform: 'web',
          appId: browser.url,
          deviceId: expect.stringContaining('http://127.0.0.1:'),
          deviceName: 'Chrome',
          metroPort: null,
          strategy: 'cdp',
          targets: 1,
          reverseRestored: [],
        },
      },
    });
    await client.request('action', { action: 'reload', workspace });
    expect(browser.methods.filter((method) => method === 'Page.reload')).toHaveLength(2);
    expect(stimCalls()).toEqual([]);
    const [first] = readAudit();
    expect(first).toEqual({
      at: expect.any(String),
      device: { id: readDevices()[0]!.id, name: 'Test phone' },
      action: 'reload',
      workspace,
      platform: 'web',
      ok: true,
      durationMs: expect.any(Number),
    });
    expect(readAudit().map((record) => [record.action, record.ok])).toEqual([
      ['reload', true],
      ['reload', true],
    ]);
  });

  it('reports the API refusal with its code and remedy', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const port = await start();
    const client = await authed(port, true);
    expect(await client.request('action', { action: 'reload', workspace })).toMatchObject({
      error: {
        code: 'action-failed',
        message: 'STIM_RELOAD_STOPPED: No live app launch is recorded. Run `stim ios` or `stim android` first.',
      },
    });
    expect(readAudit()).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'action-failed' }) }),
    ]);
  });

  it('runs one action per workspace at a time and ends one that runs past its timeout', async () => {
    const browser = await reloadBrowser(workspace, true);
    const port = await start({ actionLimits: { timeoutMs: process.platform === 'win32' ? 5000 : 500 } });
    const client = await authed(port, true);
    const other = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'reload', workspace } }));
    await browser.attaching;
    expect(await other.request('action', { action: 'reload', workspace })).toMatchObject({
      error: { code: 'action-busy' },
    });
    expect(await client.next()).toMatchObject({
      id: 10,
      error: { code: 'action-failed', message: expect.stringContaining('did not finish') },
    });
    await browser.closed;
    expect(browser.methods).not.toContain('Page.reload');
    expect(readAudit().map((record) => record.error?.code)).toEqual(['action-busy', 'action-failed']);
  });

  it('keeps running an action when the client disconnects', async () => {
    const browser = await reloadBrowser(workspace, true);
    const port = await start();
    const client = await authed(port, true);
    const other = await authed(port, true);
    client.socket.send(JSON.stringify({ id: 10, method: 'action', params: { action: 'reload', workspace } }));
    await browser.attaching;
    client.socket.terminate();
    await client.closed;
    expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty('error.code', 'action-busy');
    browser.release();
    await browser.closed;
    await until(() => readAudit().some((record) => record.action === 'reload' && record.ok));
    expect(browser.methods).toContain('Page.reload');
  });
});

describe('request log', () => {
  it('writes a failed request to the service log with the client and its run id, and nothing else', async () => {
    const lines: string[] = [];
    const port = await start({ requestLog: createRequestLog({ service: (line) => lines.push(line), debug: off }) });
    const { id, keyPair } = await pair(port);
    const client = await connect(port, undefined, { keyPair });
    await client.request('hello', { client: { ...CLIENT, runId: 'desktop-run.7' } });
    await client.request('machine.get');
    const token = 'request-param-text';
    expect(await client.request('no.such.method', { token })).toMatchObject({ error: { code: 'unknown-method' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z stim-server: request failed method=no.such.method client=${id} run=desktop-run.7 ms=\\d+ error=unknown-method$`,
      ),
    );
    expect(lines.join('\n')).not.toContain(token);
  });

  it('with debug on, times every request and splits the hello into its slow steps', async () => {
    const lines: string[] = [];
    const port = await start({
      host: { executable: join(root, 'missing'), name: 'Stim Host Dev' },
      requestLog: createRequestLog({
        service: (line) => lines.push(line),
        debug: { enabled: () => true, log: () => {} },
      }),
    });
    const { keyPair } = await pair(port, '100.64.0.2');
    lines.length = 0;
    await returning(port, keyPair, '100.64.0.2');
    expect(lines.find((line) => line.includes('method=hello'))).toMatch(/debug request method=hello .*probe=\d+/);
  });
});

const off = { enabled: () => false, log: () => {} };

describe('the web share listener of a server', () => {
  const service = (installed: boolean): ServerOptions['service'] => ({
    label: 'dev.stim.test',
    node: process.execPath,
    script: '/nowhere',
    runsAsService: async () => installed,
  });

  async function configure(): Promise<number> {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    writeFileSync(
      join(String(process.env.STIM_HOME), 'config.json'),
      JSON.stringify({
        projects: { [workspace]: {} },
        share: { exposure: 'proxy', publicUrl: 'https://demo.example.com', port },
      }),
    );
    return port;
  }

  const answers = (port: number) =>
    new Promise<boolean>((resolve) => {
      const probe = connectNet(port, '127.0.0.1', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });

  test('stays bound with no share when stim-server runs as the installed service with proxy exposure', async () => {
    const port = await configure();
    await start({ service: service(true) });
    await vi.waitFor(async () => expect(await answers(port)).toBe(true));
    const answer = await fetch(`http://127.0.0.1:${port}/s/${'A'.repeat(43)}/`);
    expect(answer.status).toBe(404);
    expect(await answer.text()).toContain('This share has ended or the link is wrong');
    await server?.close();
    expect(await answers(port)).toBe(false);
  });

  test.each([
    ['a server that is not the installed service', { service: service(false) }],
    ['the on-demand server of stim share', { service: service(true), shareServer: { idle: () => {} } }],
    ['a server with no service label', {}],
  ] as const)('does not bind it for %s', async (_name, overrides) => {
    const port = await configure();
    await start(overrides);
    await new Promise((done) => setTimeout(done, 200));
    expect(await answers(port)).toBe(false);
  });
});

describe('attached Desktop admission', () => {
  test('refuses new lifecycle and setup work before opening a subscription', async () => {
    await start({ attached: true, desktopBootstrap: null });
    assert(server);
    const client = await localConnect(server);
    await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    const api = vi.spyOn(stimSelf, 'createStim');
    const methods = [
      'desktop.start.subscribe',
      'desktop.run.subscribe',
      'desktop.build.subscribe',
      'desktop.gc.subscribe',
      'desktop.worktree.warm.subscribe',
      'desktop.worktree.remove.subscribe',
      'desktop.machine-access.subscribe',
      'desktop.remedy.subscribe',
      'desktop.setup.subscribe',
    ];
    for (const method of methods)
      expect(await client.request(method, { cwd: root })).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('stim serve') },
      });
    expect(api).not.toHaveBeenCalled();
    api.mockRestore();
    expect(await client.request('desktop.stop.subscribe', {})).toHaveProperty('error.code', 'bad-request');
    expect(await client.request('desktop.settings.schema', {})).toHaveProperty('result');
    client.socket.close();
  });

  test('a persistent server still accepts Desktop lifecycle requests for validation', async () => {
    await start({ desktopBootstrap: null });
    assert(server);
    const client = await localConnect(server);
    await client.request('hello', { client: CLIENT, desktopBootstrap: true });
    const original = stimSelf.createStim;
    const startWork = vi.fn<() => Promise<never>>(async () => {
      throw new Error('fixture start');
    });
    const api = vi
      .spyOn(stimSelf, 'createStim')
      .mockImplementation((options) => ({ ...original(options), start: startWork }));
    try {
      expect(await client.request('desktop.start.subscribe', { cwd: root })).toHaveProperty('result.subscription');
      await until(() => startWork.mock.calls.length > 0);
    } finally {
      api.mockRestore();
      client.socket.close();
    }
  });
});
