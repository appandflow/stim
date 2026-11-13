import {
  registryWatch,
  fakeTailscale,
  CLIENT,
  root,
  workspace,
  start,
  connect,
  pair,
  returning,
  desktop,
  alive,
  authed,
} from './server-harness.ts';
import assert from 'node:assert';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect as connectNet } from 'node:net';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import {
  readHostedSessions,
  deviceHostArea,
  buildSlotPath,
  machineCapacity,
  tryAcquireBuildSlotClaim,
  isJsonObject,
  stimBuildId,
} from '@stim-cli/core/state';
import { BuildHost } from '../../stim-cli/src/job/offload/host.ts';
import { protocolJsonSchema } from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { readAudit } from '../src/actions.ts';
import { revokeDevice } from '../src/registry.ts';
import { type NoiseKeyPair } from '@stim-cli/core/noise';
import { setupClient, type Client } from './noise-client.ts';
import { workspaceStateDir } from '@stim-cli/core';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { serviceRoot } from '../src/service-manager.ts';

describe('hosted device sessions', () => {
  test('an attached server refuses hosted work before starting a worker while allowing session queries', async () => {
    const port = await start({ attached: true });
    const pending = setupClient(['device-host'], 'Client');
    const client = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
    const session = '12345678-1234-1234-1234-123456789abc';
    const attempt = 'test-attempt';
    const hash = 'a'.repeat(64);
    const requests: [string, unknown][] = [
      ['device-host.runtime.install', { runtime: '17.2' }],
      ['device-host.offer', { platform: 'ios' }],
      ['device-host.reserve', { workspace: '/client/app', slot: 'default', platform: 'ios', attempt }],
      [
        'device-host.app.offer',
        { session, attempt, bundleId: 'dev.test.app', mode: 'development', manifest: { sha256: hash, size: 1 } },
      ],
      ['device-host.app.chunk', { session, attempt, sha256: hash, offset: 0, data: 'YQ==' }],
      ['device-host.app.handoff', { session, attempt, build: { handoff: 'test', sha256: hash } }],
      ['device-host.app.launch', { session, attempt }],
    ];
    for (const [method, params] of requests)
      expect(await client.request(method, params)).toMatchObject({
        error: { code: 'device-busy', message: expect.stringContaining('stim serve') },
      });
    expect(await client.request('device-host.attach', { session })).not.toMatchObject({
      error: { code: 'device-busy' },
    });
    expect(await client.request('device-host.stop', { session })).not.toMatchObject({ error: { code: 'device-busy' } });
    expect(readHostedSessions()).toEqual([]);
    client.socket.close();
  });

  test.skipIf(!fakeTailscale)(
    'reserves through the socket, reconnects to the same session and stops it on revocation',
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import { writeFileSync, appendFileSync } from 'node:fs';
      import { delimiter, dirname, join } from 'node:path';
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      if(input.mode==='offer') {
        process.stdout.write(JSON.stringify({platform:'ios',choice:{deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'},declined:null,resources:{cpus:4,loadPerCore:0.5,memoryFreeBytes:1000,memoryPressure:'normal',workerDiskFreeBytes:null}}));
        process.exit(0);
      }

      if(input.mode==='app-state') { process.stdout.write(JSON.stringify({state:'stopped'})); process.exit(0); }
      const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
      writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
      writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
      if(input.mode==='install') appendFileSync(join(process.env.STIM_HOME,'installs'),input.attempt+'\\n');
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':input.mode==='install'?'installed':'stopped',device,...(input.mode==='install'?{launched:'unverified'}:{})}));
    `,
      );
      const pending = setupClient(['device-host'], 'Client');
      const first = await connect(port, '100.64.0.2', { keyPair: pending.keyPair });
      const hello = await first.request('hello', { client: CLIENT, access: 'device-host' });
      expect(hello).toHaveProperty('result.capabilities', ['device-host']);
      expect(await first.request('device-host.offer', { platform: 'ios' })).toHaveProperty(
        'result.choice.runtime',
        '27.1',
      );
      expect(readHostedSessions()).toEqual([]);
      const params = { workspace: '/client/app', slot: 'default', platform: 'ios', attempt: 'socket-attempt' };
      const reserved = await first.request('device-host.reserve', params);
      expect(reserved).toHaveProperty('result.state', 'preparing');
      const id = (reserved as { result: { id: string } }).result.id;
      first.socket.close();
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'));
      const next = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      expect(await next.request('device-host.reserve', params)).toHaveProperty('result.id', id);
      expect(await next.request('device-host.attach', { attempt: 'socket-attempt' })).toHaveProperty(
        'result.state',
        'ready',
      );
      expect(await next.request('stats.get')).toHaveProperty('error.code', 'forbidden');
      expect(await next.request('device-host.metro.open', { session: id, clientMetroPort: 0 })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      const metro = { session: id };
      const opened = await next.request('device-host.metro.open', metro);
      const metroPort = (opened as { result: { port: number } }).result.port;
      expect(metroPort).toBeGreaterThan(0);
      expect(readHostedSessions()[0]?.metroPort).toBe(metroPort);

      const carrier = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      expect(await carrier.request('device-host.metro.link', { session: 'other' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(await carrier.request('device-host.metro.link', { session: id })).toHaveProperty('result', {});
      expect(await carrier.request('device-host.metro.link', { session: id })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      const device = connectNet(metroPort, '127.0.0.1');
      const answered = new Promise<string>((resolve) => device.once('data', (data) => resolve(data.toString())));
      device.write('GET /index.bundle HTTP/1.1\r\n\r\n');
      expect(await carrier.next()).toEqual({ event: 'device-host.metro.link.open' });
      expect(((await carrier.next()) as unknown as { binary: Buffer }).binary.toString()).toBe(
        'GET /index.bundle HTTP/1.1\r\n\r\n',
      );
      expect(await carrier.request('device-host.metro.link', { session: id })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      carrier.socket.send(Buffer.from('HTTP/1.1 200 OK\r\n\r\nbundle'));
      expect(await answered).toBe('HTTP/1.1 200 OK\r\n\r\nbundle');
      device.destroy();
      expect(await carrier.closed).toBe(1000);

      const content = Buffer.alloc(40000, 65);
      const digest = createHash('sha256').update(content).digest('hex');
      const files = ['Info.plist', ...Array.from({ length: 700 }, (_, index) => `Assets/resource-${index}`)].map(
        (path) => ({ path, kind: 'file', size: content.length, sha256: digest }),
      );
      const manifest = Buffer.from(JSON.stringify(files));
      expect(manifest.length).toBeGreaterThan(65536);
      const app = {
        session: id,
        attempt: 'socket-app',
        bundleId: 'dev.stim.fixture',
        mode: 'development',
        manifest: { sha256: createHash('sha256').update(manifest).digest('hex'), size: manifest.length },
      };
      expect(await next.request('device-host.app.offer', app)).toHaveProperty(
        'result.missing.0.sha256',
        app.manifest.sha256,
      );
      for (const [sha256, bytes] of [
        [app.manifest.sha256, manifest],
        [digest, content],
      ] as const) {
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          const data = bytes.subarray(offset, offset + 32768);
          expect(
            await next.request('device-host.app.chunk', {
              session: id,
              attempt: app.attempt,
              sha256,
              offset,
              data: data.toString('base64'),
            }),
          ).toHaveProperty('result.offset', offset + data.length);
        }
      }
      expect(await next.request('device-host.app.launch', { session: id, attempt: app.attempt })).toHaveProperty(
        'result.state',
        'installing',
      );
      next.socket.close();
      const reattached = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      await vi.waitFor(async () =>
        expect(
          await reattached.request('device-host.app.attach', { session: id, attempt: app.attempt }),
        ).toHaveProperty('result.state', 'installed'),
      );
      expect(await reattached.request('device-host.app.launch', { session: id, attempt: app.attempt })).toHaveProperty(
        'result.launched',
        'unverified',
      );
      expect(await reattached.request('device-host.app.state', { session: id, attempt: app.attempt })).toHaveProperty(
        'result.state',
        'stopped',
      );
      expect(await reattached.request('device-host.app.state', { session: id, attempt: 'foreign' })).toHaveProperty(
        'error',
      );
      expect(readFileSync(join(deviceHostArea(id), 'home', 'installs'), 'utf8')).toBe('socket-app\n');
      expect(await reattached.request('device-host.metro.open', metro)).toHaveProperty('result.port', metroPort);
      expect(await reattached.request('device-host.metro.close', { session: id })).toHaveProperty('result.port', null);
      await expect(fetch(`http://127.0.0.1:${metroPort}/status`)).rejects.toThrow('fetch failed');
      expect(await reattached.request('device-host.metro.open', metro)).toHaveProperty('result.port', metroPort);

      expect(revokeDevice(pending.records['device-host']!.id)).toBe(true);
      expect(await reattached.closed).toBe(4401);
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('stopped'));
      await expect(fetch(`http://127.0.0.1:${metroPort}/status`)).rejects.toThrow('fetch failed');
    },
  );

  /** A client with an approved device-host key, its ready iOS session, and that session's Metro bridge port. */
  async function linkedSession(port: number) {
    writeFileSync(
      join(root, 'device-host-worker.mjs'),
      `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
      writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
      writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:input.mode==='prepare'?[device.udid]:[],android:[],web:[]}));
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
    `,
    );
    const pending = setupClient(['device-host'], 'Client');
    const client = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
    const params = { workspace: '/client/app', slot: 'default', platform: 'ios', attempt: 'metro-links' };
    const reserved = await client.request('device-host.reserve', params);
    if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
    const id = (reserved.result as { id: string }).id;
    await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'));
    const opened = await client.request('device-host.metro.open', { session: id });
    if (!('result' in opened)) throw new Error(JSON.stringify(opened));
    const link = async () => {
      const carrier = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      expect(await carrier.request('device-host.metro.link', { session: id })).toHaveProperty('result', {});
      return carrier;
    };
    return { client, id, metroPort: (opened.result as { port: number }).port, link };
  }

  test.skipIf(!fakeTailscale)(
    'Metro links refuse an older client and another client, hold back a device that stops reading, and report a reset',
    async () => {
      const port = await start();
      const { client, id, metroPort, link } = await linkedSession(port);
      expect(
        await client.request('device-host.metro.open', { session: id, gatewayPort: 65530, secret: 'a'.repeat(64) }),
      ).toMatchObject({
        error: { code: 'protocol-unsupported', message: expect.stringContaining('Update stim on this machine') },
      });
      const other = setupClient(['device-host'], 'Other client');
      const foreign = await returning(port, other.keyPair, '100.64.0.3', 'device-host');
      expect(await foreign.request('device-host.metro.link', { session: id })).toHaveProperty(
        'error.code',
        'unknown-session',
      );

      const carrier = await link();
      const device = connectNet(metroPort, '127.0.0.1');
      device.pause();
      let received = 0;
      device.on('data', (chunk: Buffer) => (received += chunk.length));
      expect(await carrier.next()).toEqual({ event: 'device-host.metro.link.open' });
      const frame = Buffer.alloc(32 * 1024, 5);
      const total = 48 * 1024 * 1024;
      for (let sent = 0; sent < total; sent += frame.length) carrier.socket.send(frame);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(carrier.socket.bufferedAmount).toBeGreaterThan(16 * 1024 * 1024);
      device.resume();
      await vi.waitFor(() => expect(received).toBe(total), { timeout: 20_000 });
      expect(carrier.socket.bufferedAmount).toBe(0);
      device.resetAndDestroy();
      expect(await carrier.closed).toBe(4410);
    },
  );

  test.skipIf(!fakeTailscale)(
    'a clean link close still delivers what a slow device has not read, and a link that stops reading holds the device back',
    async () => {
      const port = await start();
      const { metroPort, link } = await linkedSession(port);
      const carrier = await link();
      const device = connectNet(metroPort, '127.0.0.1');
      let received = 0;
      device.on('data', (chunk: Buffer) => {
        received += chunk.length;
        device.pause();
        setTimeout(() => device.resume(), 2);
      });
      const ended = new Promise<void>((resolve) => device.once('end', () => resolve()));
      expect(await carrier.next()).toEqual({ event: 'device-host.metro.link.open' });
      const frame = Buffer.alloc(32 * 1024, 6);
      const total = 4 * 1024 * 1024;
      for (let sent = 0; sent < total; sent += frame.length) carrier.socket.send(frame);
      carrier.socket.close(1000);
      await ended;
      expect(received).toBe(total);

      const reader = await link();
      let read = 0;
      reader.socket.on('message', (data, isBinary) => {
        if (isBinary) read += data.length;
      });
      const uploader = connectNet(metroPort, '127.0.0.1');
      uploader.on('error', () => {});
      expect(await reader.next()).toEqual({ event: 'device-host.metro.link.open' });
      reader.socket.pause?.();
      const upload = 48 * 1024 * 1024;
      for (let sent = 0; sent < upload; sent += frame.length) uploader.write(frame);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(uploader.writableLength).toBeGreaterThan(16 * 1024 * 1024);
      reader.socket.resume?.();
      await vi.waitFor(() => expect(read).toBe(upload), { timeout: 20_000 });
      uploader.destroy();
    },
  );

  test.skipIf(!fakeTailscale)(
    'keeps a hosted session while its client stays connected and stops it after the client is gone',
    async () => {
      const port = await start({
        env: { STIM_DAEMON: 'on', STIM_MAINTENANCE_IDLE_STOP_HOURS: '0.0002' },
        hostedIdleSweepMs: 50,
      });
      const { client, id } = await linkedSession(port);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(readHostedSessions().find((record) => record.id === id)).toMatchObject({ state: 'ready' });

      client.socket.close();
      await vi.waitFor(() => expect(readHostedSessions().find((record) => record.id === id)?.state).toBe('stopped'), {
        timeout: 15_000,
      });
      expect(readHostedSessions().find((record) => record.id === id)?.idleStop?.reason).toMatch(/no connection/);
    },
  );

  test.skipIf(!fakeTailscale)(
    'drops a device-host connection whose peer stops answering pings and keeps one that answers',
    async () => {
      const port = await start({ clientHeartbeat: { pingMs: 50, silentMs: 400 } });
      const { client, link } = await linkedSession(port);
      const silent = await link();
      silent.socket.pause?.();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      silent.socket.resume?.();

      expect(await silent.closed).toBe(1006);
      expect(client.socket.readyState).toBe(1);
    },
  );

  test.skipIf(!fakeTailscale)(
    'stopping a hosted session closes its idle Metro links and the streams they carry',
    async () => {
      const port = await start();
      const { client, id, metroPort, link } = await linkedSession(port);
      const idle = await link();
      const carrier = await link();
      const device = connectNet(metroPort, '127.0.0.1');
      const deviceClosed = new Promise<void>((resolve) => device.once('close', () => resolve()));
      device.on('error', () => {});
      device.write('GET /index.bundle HTTP/1.1\r\n\r\n');
      expect(await carrier.next()).toEqual({ event: 'device-host.metro.link.open' });
      expect(await carrier.next()).toEqual({ binary: Buffer.from('GET /index.bundle HTTP/1.1\r\n\r\n') });
      expect(await client.request('device-host.stop', { session: id })).toHaveProperty('result.state', 'stopping');
      expect(await idle.closed).toBe(1000);
      expect(await carrier.closed).toBe(1000);
      await deviceClosed;
    },
  );

  test.skipIf(!fakeTailscale)(
    "only local Desktop control can list and stop another client's hosted sessions",
    async () => {
      const port = await start();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import { writeFileSync } from 'node:fs';
      import { delimiter, dirname, join } from 'node:path';
      const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
      writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
      writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:input.mode==='prepare'?[device.udid]:[],android:[],web:[]}));
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
    `,
      );
      const pending = setupClient(['device-host'], 'Client');
      const approved = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const params = { workspace: '/client/app', slot: 'default', platform: 'ios', attempt: 'person-stop' };
      const reserved = await approved.request('device-host.reserve', params);
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const id = (reserved.result as { id: string }).id;
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'));
      const local = await desktop();
      expect(await local.request('device-host.sessions')).toMatchObject({
        result: {
          sessions: [
            {
              id,
              client: { id: pending.records['device-host']!.id, name: 'Client' },
              platform: 'ios',
              device: 'iPhone (27.1)',
              app: null,
              state: 'ready',
              parked: false,
              workspace: '/client/app',
            },
          ],
        },
      });
      expect(await local.request('device-host.sessions', {})).toHaveProperty('result.sessions.0.id', id);
      expect(await local.request('device-host.sessions', { session: id })).toHaveProperty('error.code', 'bad-request');
      expect(await local.request('device-host.sessions.stop', {})).toHaveProperty('error.code', 'bad-request');
      expect(await local.request('device-host.sessions.stop', { session: id, extra: true })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await local.request('device-host.sessions.stop', { session: 'missing' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      const { keyPair: phoneKey } = await pair(port, '100.64.0.2', true);
      const phone = await returning(port, phoneKey, '100.64.0.2');
      for (const client of [approved, phone]) {
        for (const [method, requestParams] of [
          ['device-host.sessions', undefined],
          ['device-host.sessions.stop', { session: id }],
        ] as const) {
          expect(await client.request(method, requestParams)).toMatchObject({
            error: { code: 'forbidden', message: expect.stringContaining('local Unix socket') },
          });
        }
      }
      expect(readHostedSessions()[0]?.state).toBe('ready');
      const other = setupClient(['device-host'], 'Other client');
      const foreign = await returning(port, other.keyPair, '100.64.0.3', 'device-host');
      expect(await foreign.request('device-host.stop', { session: id })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(await local.request('device-host.sessions.stop', { session: id })).toMatchObject({
        result: { id, state: 'stopping' },
      });
      await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('stopped'));
      expect(await local.request('device-host.sessions.stop', { session: id })).toMatchObject({
        result: { id, state: 'stopped' },
      });
      expect(await local.request('device-host.sessions')).toHaveProperty('result.sessions', []);
      const again = await approved.request('device-host.reserve', { ...params, attempt: 'client-stop' });
      if (!('result' in again)) throw new Error(JSON.stringify(again));
      const againId = (again.result as { id: string }).id;
      await vi.waitFor(() => expect(readHostedSessions().find((record) => record.id === againId)?.state).toBe('ready'));
      expect(await approved.request('device-host.stop', { session: againId })).toHaveProperty(
        'result.state',
        'stopping',
      );
      await vi.waitFor(() =>
        expect(readHostedSessions().find((record) => record.id === againId)?.state).toBe('stopped'),
      );
    },
  );
});

test('build.start rejects escaping or oversized macOS resources before starting the worker', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi
    .spyOn(host, 'launch')
    .mockResolvedValue({ error: { code: 'build-refused', message: 'launched' } });
  const session = host.session('client', {} as WebSocket, () => {});
  const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'digest', stimBuild: 'b1', compat: 3 };
  const macos = { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' };
  const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    for (const options of [
      { ...macos, resources: { '../icon': 'icon' } },
      { ...macos, resources: { '/icon': 'icon' } },
      { ...macos, resources: { icon: '../icon' } },
      { ...macos, resources: { icon: '/icon' } },
      { ...macos, resources: { icon: 7 } },
      { ...macos, resources: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`icon${i}`, 'icon'])) },
      { ...macos, assetCatalog: '../Assets.xcassets' },
    ]) {
      expect(await session.start({ ...base, macos: options })).toMatchObject({ error: { code: 'bad-request' } });
    }
    expect(toolchain).not.toHaveBeenCalled();
    const valid = {
      ...base,
      macos: {
        ...macos,
        resources: { 'AppIcon.icns': 'apps/sample/Support/icon.icns' },
        assetCatalog: 'apps/sample/Support/Assets.xcassets',
      },
    };
    expect(validate({ id: 'request', method: 'build.start', params: valid })).toBe(true);
    expect(validate({ id: 'request', method: 'build.start', params: { ...valid, jdk: '17' } })).toBe(true);
    for (const jdk of ['17.0.1', '', '17; id', 17])
      expect(validate({ id: 'request', method: 'build.start', params: { ...valid, jdk } })).toBe(false);
    expect(await session.start(valid)).toMatchObject({ error: { code: 'build-refused', message: 'launched' } });
    expect(toolchain).toHaveBeenCalledOnce();
    expect(
      validate({
        id: 'request',
        method: 'build.start',
        params: {
          ...valid,
          macos: {
            ...valid.macos,
            resources: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`icon${i}`, 'icon'])),
          },
        },
      }),
    ).toBe(false);
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('build.start needs the build compatibility version and passes it and the JDK to the worker job', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const worker = {
    stimBuild: 'b1',
    compat: 3,
    arch: 'arm64',
    xcode: null,
    simulatorSdk: null,
    macosSdk: null,
    cocoapods: null,
    runtimes: [],
    jdk: null,
    androidSdk: null,
  };
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(worker);
  const launch = vi.spyOn(host, 'launch').mockResolvedValue({ error: { code: 'build-refused', message: 'launched' } });
  const socket = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: () => {} };
  const session = host.session('client', socket, () => {});
  const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'digest' };
  const macos = { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' };
  const message = async (params: Record<string, unknown>) => {
    const reply = await session.start({ ...base, macos, ...params });
    return 'error' in reply ? reply.error.message : null;
  };
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    expect(await message({ stimBuild: 'b2', compat: 3 })).toBe('launched');
    expect(launch.mock.calls.at(-1)?.[0].job).toMatchObject({ stimBuild: 'b2', compat: 3 });
    expect(launch.mock.calls.at(-1)?.[0].job).not.toHaveProperty('jdk');
    expect(await message({ stimBuild: 'b1' })).toBe('build.start needs params.compat.');
    expect(await message({ stimBuild: 'b2', compat: 3, jdk: '17' })).toBe('launched');
    expect(launch.mock.calls.at(-1)?.[0].job).toMatchObject({ jdk: '17' });
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('native Gradle requires declared source scope and a null artifact identity before worker admission', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi
    .spyOn(host, 'launch')
    .mockResolvedValue({ error: { code: 'build-refused', message: 'launched' } });
  const session = host.session('client', {} as WebSocket, () => {});
  const android = { variant: 'freeRelease', abi: null, gradleBuildCache: true, pch: 'auto', compilerCache: 'none' };
  const inputs = { complete: true, ignored: [], outputs: ['app/build'] };
  const native = { provider: 'gradle', sourceDigest: 'a'.repeat(64), inputs };
  const valid = {
    configuration: null,
    scheme: null,
    runtime: null,
    packageName: null,
    isExpo: false,
    optimizations: null,
    repo: 'app-1',
    project: '',
    platform: 'android',
    fingerprint: null,
    stimBuild: 'b1',
    compat: 3,
    android,
    native,
  };
  try {
    session.sync({ repo: 'app-1', files: [], done: true });
    for (const invalid of [
      { ...valid, native: undefined },
      { ...valid, fingerprint: 'fake-reusable-identity' },
      { ...valid, native: { ...native, sourceDigest: '' } },
      { ...valid, native: { ...native, inputs: { ...inputs, complete: false } } },
      { ...valid, native: { ...native, inputs: { ...inputs, outputs: ['../outside'] } } },
      ...[null, {}, { read: false, write: true }, { read: 'false', write: true, remote: true }].map((cache) =>
        Object.assign({}, valid, { native: { ...native, cache } }),
      ),
      { ...valid, platform: 'ios', runtime: 'iOS-27-0' },
    ])
      expect(await session.start(invalid)).toMatchObject({ error: { code: 'bad-request' } });
    expect(toolchain).not.toHaveBeenCalled();
    const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
    expect(validate({ id: 'request', method: 'build.start', params: valid })).toBe(true);
    expect(
      validate({
        id: 'request',
        method: 'build.start',
        params: { ...valid, native: { ...native, cache: { read: false, write: true, remote: false } } },
      }),
    ).toBe(true);
    for (const params of [
      { ...valid, native: undefined },
      { ...valid, fingerprint: 'fake-reusable-identity' },
    ])
      expect(validate({ id: 'request', method: 'build.start', params })).toBe(false);
    expect(await session.start(valid)).toMatchObject({ error: { code: 'build-refused', message: 'launched' } });
    expect(toolchain).toHaveBeenCalledOnce();
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

test('native and general toolchain reports cache independently from each Ruby context', async () => {
  const worker = join(root, 'toolchain-context.mjs');
  const toolchainCalls = join(root, 'toolchain-context.calls');
  writeFileSync(
    worker,
    `
import { appendFileSync } from 'node:fs';
const context = process.argv.slice(2);
appendFileSync(${JSON.stringify(toolchainCalls)}, JSON.stringify(context) + '\\n');
const native = context[0] === 'offer-native-xcode';
console.log(JSON.stringify({ stimBuild: 'b1', xcode: 'Xcode 27.0', simulatorSdk: '27.0', runtimes: ['iOS-27-0'], cocoapods: native ? null : (context[1] ?? 'default'), macosSdk: native ? null : '26.6' }));
`,
  );
  const host = new BuildHost({ worker, env: process.env });
  try {
    for (const context of [undefined, 'ruby-3.3.4']) {
      expect(await host.toolchain(context, 'xcode')).toMatchObject({
        cocoapods: null,
        macosSdk: null,
        runtimes: ['iOS-27-0'],
      });
      expect(await host.toolchain(context)).toMatchObject({ cocoapods: context ?? 'default', macosSdk: '26.6' });
      expect(await host.toolchain(context, 'xcode')).toMatchObject({ cocoapods: null, macosSdk: null });
      expect(await host.toolchain(context)).toMatchObject({ cocoapods: context ?? 'default' });
    }
    expect(
      readFileSync(toolchainCalls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([['offer-native-xcode'], ['offer'], ['offer', 'ruby-3.3.4']]);
  } finally {
    await host.close();
  }
});

test('native build admission rejects invalid provider identity before toolchain or worker work', async () => {
  const host = new BuildHost({ worker: 'unused-worker', env: process.env });
  const toolchain = vi.spyOn(host, 'toolchain').mockResolvedValue(null);
  const session = host.session('client', {} as WebSocket, () => {});
  const native = {
    provider: 'xcode',
    sourceDigest: 'a'.repeat(64),
    cacheKey: 'artifact-key',
    arch: 'arm64',
    parameters: {},
  };
  const base = {
    repo: 'app-1',
    project: '',
    platform: 'ios',
    runtime: 'iOS-27-0',
    configuration: 'Debug',
    scheme: 'Native',
    packageName: null,
    isExpo: false,
    fingerprint: 'input-key',
    stimBuild: 'b1',
    compat: 3,
    native,
    optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
  };
  const empty = createHash('sha256').update('').digest('hex');
  const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
  try {
    expect(
      session.sync({
        repo: 'app-1',
        files: [{ path: 'Empty.bundle', kind: 'directory', size: 1, sha256: empty }],
        done: true,
      }),
    ).toHaveProperty('error.code', 'bad-request');
    expect(
      session.sync({
        repo: 'app-1',
        files: [{ path: 'Empty.bundle', kind: 'directory', size: 0, sha256: empty }],
        done: true,
      }),
    ).toHaveProperty('result.missing', [empty]);
    expect(session.blob(Buffer.from(empty, 'hex'))).toBeNull();
    for (const changed of [
      { provider: 'gradle' },
      { sourceDigest: 'unverified' },
      { cacheKey: '' },
      { arch: 'armv7' },
      { parameters: null },
    ]) {
      const params = { ...base, native: { ...native, ...changed } };
      expect(validate({ id: 'request', method: 'build.start', params })).toBe(false);
      expect(await session.start(params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(await session.start({ ...base, native: undefined })).toHaveProperty('error.code', 'bad-request');
    expect(await session.start({ ...base, platform: 'android' })).toHaveProperty('error.code', 'bad-request');
    expect(await session.start({ ...base, optimizations: null })).toHaveProperty('error.code', 'bad-request');
    expect(await host.offer('client', { repo: 'app-1', native: 'unsupported' })).toHaveProperty(
      'error.code',
      'bad-request',
    );
    expect(validate({ id: 'request', method: 'build.offer', params: { repo: 'app-1', native: 'unsupported' } })).toBe(
      false,
    );
    expect(toolchain).not.toHaveBeenCalled();
    expect(validate({ id: 'request', method: 'build.offer', params: { repo: 'app-1', native: 'xcode' } })).toBe(true);
    expect(await host.offer('client', { repo: 'app-1', native: 'xcode' })).toHaveProperty(
      'error.code',
      'build-refused',
    );
    expect(toolchain).toHaveBeenLastCalledWith(null, 'xcode');
    toolchain.mockClear();
    expect(validate({ id: 'request', method: 'build.start', params: base })).toBe(true);
    const launch = vi
      .spyOn(host, 'launch')
      .mockResolvedValue({ error: { code: 'build-refused', message: 'launched' } });
    expect(await session.start(base)).toHaveProperty('error.code', 'build-refused');
    expect(toolchain).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  } finally {
    toolchain.mockRestore();
    await host.close();
  }
});

describe('offloaded builds', () => {
  const startWorker = (options: NonNullable<Parameters<typeof start>[0]> = {}) =>
    start({ ...options, buildLimits: { minFreeBytes: 0, evictionMarginBytes: 0, ...options.buildLimits } });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const file = (path: string, text: string) => ({ path, kind: 'file', size: text.length, sha256: sha(text) });
  const blob = (text: string) => Buffer.concat([Buffer.from(sha(text), 'hex'), Buffer.from(text)]);
  const START = {
    repo: 'app-1',
    project: 'apps/mobile',
    platform: 'ios',
    configuration: null,
    scheme: null,
    runtime: 'iOS-27-0',
    fingerprint: 'f00d',
    fingerprintSchema: 2,
    fingerprintSources: [],
    fingerprintEnv: { set: {}, absent: [] },
    fingerprintNative: 'tracked',
    fingerprintLayout: { projectPath: null, gradleRoot: null, module: null },
    fingerprintRuntime: { node: '22.22', evaluator: '0'.repeat(64), packages: {} },
    packageName: 'mobile',
    isExpo: true,
    optimizations: null,
    stimBuild: 'b1',
    compat: 3,
  };
  const configure = (config: Record<string, unknown>) =>
    writeFileSync(
      join(process.env.STIM_HOME!, 'config.json'),
      JSON.stringify({ projects: { [workspace]: {} }, ...config }),
    );

  beforeEach(() => configure({ server: { maxLoadPerCore: 100_000 } }));

  const startJob = (client: Client) =>
    client.request('job.start', { kind: 'offload-build', stim: '9.9.9', build: stimBuildId(root), repo: 'app-1' });

  async function buildClient(
    port: number,
    peer = '100.64.0.2',
    machine = setupClient(['build'], 'Laptop'),
    job = true,
  ): Promise<{ client: Client; id: string; keyPair: NoiseKeyPair; spliced: string }> {
    const client = await returning(port, machine.keyPair, peer, 'build');
    const started = job ? await startJob(client) : { result: { job: '' } };
    expect(started).toHaveProperty('result.job');
    const spliced = (started as { result: { job: string } }).result.job;
    return { client, id: machine.records.build!.id, keyPair: machine.keyPair, spliced };
  }

  async function eventually(check: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  }

  async function progress(client: Client): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for (;;) {
      const message = (await client.next()) as unknown as Record<string, unknown>;
      events.push(message);
      if (message.outcome) return events;
    }
  }

  test.skipIf(!fakeTailscale)(
    'a machine that cannot host refuses device-host access and still takes builds',
    async () => {
      const port = await startWorker({ hostsDevices: false });
      const machine = setupClient(['build', 'device-host'], 'Host client');
      const asking = await connect(port, '100.64.0.3', { keyPair: machine.keyPair });
      expect(await asking.request('hello', { client: CLIENT, access: 'device-host' })).toMatchObject({
        error: { code: 'forbidden', message: expect.stringContaining('needs a Mac') },
      });
      const { client } = await buildClient(port, '100.64.0.3', machine);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { max: 0 } },
      });
    },
  );

  test.skipIf(!fakeTailscale)(
    'mirrors a content-addressed manifest, builds it and returns the artifact with its digest',
    async () => {
      const port = await startWorker();
      const { client, id } = await buildClient(port);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: {
          toolchain: { stimBuild: 'b1', runtimes: ['iOS-27-0'], macosSdk: '27.0' },
          capacity: { running: 0, max: 0 },
          warm: { checkout: false, dependencies: false, build: false },
        },
      });

      const first = await client.request('build.sync', {
        repo: 'app-1',
        files: [file('package.json', '{}'), file('apps/mobile/app.json', '{"a":1}')],
        done: false,
      });
      expect(first).toMatchObject({ result: { missing: [sha('{}'), sha('{"a":1}')] } });
      const second = await client.request('build.sync', {
        repo: 'app-1',
        files: [file('apps/mobile/copy.json', '{}')],
        done: true,
      });
      expect(second).toMatchObject({ result: { missing: [] } });
      expect(await client.request('build.start', START)).toMatchObject({ error: { code: 'bad-request' } });

      client.socket.send(blob('{}'));
      client.socket.send(blob('{"a":1}'));
      const fingerprintSources = [
        { id: 'ios/Podfile', kind: 'file', hash: 'a'.repeat(64) },
        { id: 'config', kind: 'config', hash: 'b'.repeat(64) },
      ];
      expect(
        await client.request('build.start', { ...START, fingerprintSources: [{ id: 'ios', hash: '../x' }] }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('build.start', { ...START, fingerprintSchema: 1 })).toMatchObject({
        error: { code: 'bad-request' },
      });
      for (const bad of [3, '/absolute', '../outside', '', 'a\0b', 'a//b']) {
        expect(
          await client.request('build.start', {
            ...START,
            fingerprintEnv: { set: { APP_PATH: { path: bad } }, absent: [] },
          }),
        ).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      const started = await client.request('build.start', {
        ...START,
        fingerprintSources,
        podsOnWorker: true,
        reuseArtifact: true,
      });
      expect(started).toMatchObject({ result: { job: expect.any(String) } });
      const job = (started as { result: { job: string } }).result.job;
      const events = await progress(client);
      expect(events).toEqual([
        { event: 'build.progress', job, phase: 'build', msg: 'compiling' },
        { event: 'build.progress', job, record: { src: 'build', level: 'info', msg: 'CompileC' } },
        {
          event: 'build.progress',
          job,
          outcome: expect.objectContaining({
            ok: true,
            artifact: { name: 'App.app', size: 17, sha256: sha('app archive bytes') },
            reused: true,
          }),
        },
      ]);

      const area = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1');
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.home).toBe(join(area, 'home'));
      expect(ran.job).toMatchObject({
        area,
        project: 'apps/mobile',
        expectedFingerprint: 'f00d',
        expectedSources: fingerprintSources,
        fingerprintSchema: 2,
        fingerprintEnv: START.fingerprintEnv,
        fingerprintNative: 'tracked',
        fingerprintLayout: START.fingerprintLayout,
        fingerprintRuntime: START.fingerprintRuntime,
        podsOnWorker: true,
        reuseArtifact: true,
        artifactCache: join(area, 'artifact-cache'),
        runtime: 'iOS-27-0',
      });
      expect(ran.job.manifest.map((entry: { path: string }) => entry.path).toSorted()).toEqual([
        'apps/mobile/app.json',
        'apps/mobile/copy.json',
        'package.json',
      ]);
      expect(readClaimSet(`${area}.claims`).live).toEqual([]);

      client.socket.send(JSON.stringify({ id: 99, method: 'build.artifact', params: { job } }));
      const frame = (await client.next()) as unknown as { binary: Buffer };
      expect(frame.binary.subarray(0, 32).toString('hex')).toBe(sha('app archive bytes'));
      expect(frame.binary.subarray(32).toString()).toBe('app archive bytes');
      expect(await client.next()).toEqual({
        id: 99,
        result: {
          name: 'App.app',
          size: 17,
          sha256: sha('app archive bytes'),
          handoff: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(existsSync(join(area, 'out', job))).toBe(true);
      expect(readAudit()).toMatchObject([{ action: 'build', workspace: 'app-1', ok: true }]);

      const viewer = await authed(port);
      expect(await startJob(viewer)).toMatchObject({ error: { code: 'forbidden' } });
      expect(await viewer.request('build.offer', { repo: 'app-1' })).toHaveProperty('error.code', 'unknown-method');
      expect(await viewer.request('device-host.offer', { platform: 'ios' })).toHaveProperty('error.code', 'forbidden');
    },
  );

  test.skipIf(!fakeTailscale)(
    'a reconnected approved client fetches an exact completed archive without another build',
    async () => {
      const port = await startWorker();
      const { client, id, keyPair } = await buildClient(port);
      const identity = { fingerprint: 'f00d', cacheKey: 'source-sdk27-arm64-target' };
      expect(await client.request('build.sync', { repo: 'app-1', files: [], done: true })).toHaveProperty(
        'result.missing',
        [],
      );
      const started = await client.request('build.start', {
        ...START,
        project: '',
        native: {
          provider: 'xcode',
          sourceDigest: sha(''),
          cacheKey: identity.cacheKey,
          arch: 'arm64',
          parameters: { sdk: '27.0' },
        },
        optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
      });
      expect(started).toHaveProperty('result.job');
      await progress(client);
      client.socket.close();
      await client.closed;
      const area = join(root, 'home', 'build-worker', id, 'repos', 'app-1');
      rmSync(join(area, 'out'), { recursive: true, force: true });
      const again = await returning(port, keyPair, '100.64.0.2', 'build');
      expect(await startJob(again)).toHaveProperty('result.job');
      expect(await again.request('build.offer', { repo: 'app-1', native: 'xcode', artifact: identity })).toHaveProperty(
        'result.artifact',
        {
          ...identity,
          name: 'App.app',
          size: 17,
          sha256: sha('app archive bytes'),
        },
      );
      again.socket.send(
        JSON.stringify({ id: 99, method: 'build.cached-artifact', params: { repo: 'app-1', artifact: identity } }),
      );
      const frame = await again.next();
      if (!('binary' in frame) || !Buffer.isBuffer(frame.binary)) throw new Error('Expected an archive frame');
      expect(frame.binary.subarray(32).toString()).toBe('app archive bytes');
      expect(await again.next()).toMatchObject({
        id: 99,
        result: { ...identity, size: 17, sha256: sha('app archive bytes') },
      });
      expect(readAudit().filter((entry) => entry.action === 'build')).toHaveLength(1);
    },
  );

  test.skipIf(!fakeTailscale)(
    'lets only a machine approved for builds or device hosting ask the server to update itself',
    async () => {
      const port = await startWorker({
        service: {
          label: 'dev.stim.test',
          node: process.execPath,
          script: '/nowhere',
          runsAsService: async () => true,
        },
      });
      const { client } = await buildClient(port, undefined, undefined, false);
      expect(await client.request('engine.update.status')).toMatchObject({
        result: {
          server: { version: '1.2.3' },
          service: 'dev.stim.test',
          acceptsClientBuilds: false,
          running: null,
        },
      });
      expect(
        await client.request('engine.update', { packages: [{ name: 'a.tgz', size: 1, sha256: sha('a') }] }),
      ).toMatchObject({ error: { code: 'forbidden', message: expect.stringContaining('server.acceptClientBuilds') } });
      expect(await client.request('engine.update', { version: 'latest' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const host = await returning(port, setupClient(['device-host']).keyPair, '100.64.0.3', 'device-host');
      expect(await host.request('engine.update.status')).toMatchObject({ result: { service: 'dev.stim.test' } });
      const viewer = await authed(port);
      expect(await viewer.request('engine.update.status')).toMatchObject({ error: { code: 'forbidden' } });
      expect(await viewer.request('engine.update', { version: '1.15.0' })).toMatchObject({
        error: { code: 'forbidden' },
      });
    },
  );

  test.skipIf(!fakeTailscale)('declines offloaded builds while an update of this server runs', async () => {
    const home = process.env.HOME;
    const engineRoot = process.env.STIM_ENGINE_ROOT;
    process.env.HOME = root;
    try {
      const updater = join(root, 'updater.mjs');
      const release = join(root, 'release-updater');
      writeFileSync(
        updater,
        `const { existsSync } = await import('node:fs'); const wait = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(wait); console.log(JSON.stringify({ refused: 'another update is running' })); process.exit(1); } }, 50);`,
      );
      const script = join(root, 'engine', '0123456789ab', 'dist', 'cli.mjs');
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, '');
      process.env.STIM_ENGINE_ROOT = join(root, 'engine');
      const port = await startWorker({
        service: {
          label: 'dev.stim.drain',
          node: process.execPath,
          script,
          runsAsService: async () => true,
          detached: (node, args) => ({ file: node, args: [updater, ...args] }),
        },
      });
      const { client } = await buildClient(port, undefined, undefined, false);
      expect(await client.request('engine.update', { version: '1.15.0' })).toMatchObject({
        result: { state: 'installing' },
      });
      expect(await startJob(client)).toMatchObject({
        error: { code: 'build-busy', message: 'stim-server is updating to release 1.15.0' },
      });
      writeFileSync(release, '');
      await eventually(() => readAudit().some((record) => record.action === 'engine.update.ended'));
      const { client: building } = await buildClient(port);
      expect(await building.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { declined: null } },
      });
      expect(await client.request('engine.update.status')).toMatchObject({
        result: {
          running: null,
          last: {
            ok: false,
            message: expect.stringContaining('exited with code 1: The engine refused it: another update is running.'),
          },
        },
      });
      const later = {
        at: '2999-01-01T00:00:00.000Z',
        target: 'release 1.15.0',
        ok: true,
        message: 'updated by another run',
      };
      writeFileSync(join(serviceRoot('dev.stim.drain'), 'last-update.json'), JSON.stringify(later));
      expect(await client.request('engine.update.status')).toMatchObject({ result: { last: later } });
    } finally {
      process.env.STIM_ENGINE_ROOT = engineRoot;
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  test.skipIf(!fakeTailscale)(
    "builds an Android job with its Gradle options in the repository's own Gradle home",
    async () => {
      const port = await startWorker();
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const android = { variant: null, abi: 'arm64-v8a', gradleBuildCache: true, pch: 'auto', compilerCache: 'ccache' };
      const base = { ...START, platform: 'android', runtime: null };
      expect(await client.request('build.start', base)).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('build.start', { ...base, android: { ...android, abi: '../x' } })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('build.start', { ...base, android: { ...android, module: 'app' } })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const layout = { gradleRoot: '../..', module: ':packages:rn-tester:android:app' };
      expect(await client.request('build.start', { ...base, android: { ...android, ...layout } })).toMatchObject({
        result: { job: expect.any(String) },
      });
      await progress(client);
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.job).toMatchObject({ platform: 'android', runtime: null, android: { ...android, ...layout } });
      expect(ran.gradle).toBe(join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1', 'cache', 'gradle'));
    },
  );

  test.skipIf(!fakeTailscale)(
    'refuses malformed macOS jobs and launches valid jobs with a private SwiftPM cache',
    async () => {
      const port = await startWorker();
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('Package.swift', 'x')], done: true });
      client.socket.send(blob('x'));
      const base = { repo: 'app-1', project: '', platform: 'macos', fingerprint: 'f00d', stimBuild: 'b1', compat: 3 };
      const macos = {
        product: 'Sample',
        infoPlist: 'Support/Info.plist',
        bundleId: 'dev.sample.stim.test',
        resources: { 'AppIcon.icns': 'apps/sample/Support/icon.icns' },
        assetCatalog: 'apps/sample/Support/Assets.xcassets',
      };
      for (const options of [
        undefined,
        { ...macos, product: '../Sample' },
        { ...macos, infoPlist: '../Info.plist' },
        { ...macos, bundleId: '-bad' },
      ]) {
        expect(await client.request('build.start', { ...base, macos: options })).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      expect(await client.request('build.start', { ...base, macos })).toMatchObject({
        result: { job: expect.any(String) },
      });
      await progress(client);
      const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
      expect(ran.job).toMatchObject({
        platform: 'macos',
        project: '',
        macos,
        swiftpmCache: join(process.env.STIM_HOME!, 'build-worker', id, 'cache', 'swiftpm'),
      });
      const scratch = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1', 'macos', 'root');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'output'), 'built');
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { warm: { build: false } },
      });
    },
  );

  async function nativeBuild(
    port: number,
    peer: string,
    platform: 'android' | 'macos' = 'macos',
    machine = setupClient(['build'], 'Laptop'),
    repo = 'app-1',
  ) {
    const { client, id } = await buildClient(port, peer, machine);
    const synced = await client.request('build.sync', { repo, files: [file('Package.swift', 'x')], done: true });
    if (JSON.stringify(synced).includes(sha('x'))) client.socket.send(blob('x'));
    const started = await client.request('build.start', {
      ...START,
      repo,
      project: '',
      platform,
      fingerprint: 'f00d',
      stimBuild: 'b1',
      compat: 3,
      ...(platform === 'android'
        ? {
            android: {
              variant: 'debug',
              abi: 'arm64-v8a',
              gradleBuildCache: true,
              pch: 'auto',
              compilerCache: 'ccache',
            },
          }
        : { macos: { product: 'Sample', infoPlist: 'Support/Info.plist', bundleId: 'dev.sample.stim.test' } }),
    });
    const job = (started as { result: { job: string } }).result.job;
    await progress(client);
    const fetched = await client.request('build.artifact', { job });
    const { handoff, sha256 } = (fetched as { result: { handoff?: string; sha256: string } }).result;
    const out = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', repo, 'out', job);
    return { id, out, build: { handoff: handoff!, sha256 } };
  }

  test.skipIf(!fakeTailscale)(
    "keeps a client's retained build per repository until that repository fetches another",
    async () => {
      const port = await startWorker();
      const machine = setupClient(['build'], 'Laptop');
      const first = await nativeBuild(port, '100.64.0.2', 'macos', machine, 'app-1');
      const other = await nativeBuild(port, '100.64.0.2', 'macos', machine, 'app-2');
      expect(existsSync(join(first.out, 'App.app'))).toBe(true);
      expect(existsSync(join(other.out, 'App.app'))).toBe(true);
      await nativeBuild(port, '100.64.0.2', 'macos', machine, 'app-1');
      expect(existsSync(first.out)).toBe(false);
      expect(existsSync(join(other.out, 'App.app'))).toBe(true);
    },
  );

  test.skipIf(!fakeTailscale)(
    'hands a fetched macOS build once, and only to a hosted session of the same machine key',
    async () => {
      const port = await startWorker();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import {writeFileSync} from 'node:fs';import {join} from 'node:path';
        const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={architecture:'arm64',macosVersion:'27.0',appSlot:input.appSlot};
        if(input.mode==='prepare')writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const machine = setupClient(['build', 'device-host'], 'Hosting client');
      const elsewhere = await nativeBuild(port, '100.64.0.2');
      const revoked = await nativeBuild(port, '100.64.0.2');
      const own = await nativeBuild(port, '100.64.0.2', 'macos', machine);
      expect(own.build.handoff).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(own.out, 'app.tgz'))).toBe(false);
      expect(existsSync(join(own.out, 'App.app'))).toBe(true);

      const hosting = await returning(port, machine.keyPair, '100.64.0.2', 'device-host');
      const reserved = await hosting.request('device-host.reserve', {
        workspace: '/client/app',
        slot: 'default',
        platform: 'macos',
        attempt: 'handoff',
      });
      const session = (reserved as { result: { id: string } }).result.id;
      await vi.waitFor(async () =>
        expect(await hosting.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const entry = (path: string, kind: string, text: string) => ({ ...file(path, text), kind });
      const files = [
        entry('Contents/Current', 'link', 'MacOS'),
        entry('Contents/Info.plist', 'file', 'plist bytes'),
        entry('Contents/MacOS/Sample', 'exec', 'binary bytes'),
        entry('Contents/PkgInfo', 'file', 'APPL????'),
        entry('Contents/data', 'file', 'data bytes'),
      ];
      const manifest = JSON.stringify(files);
      const app = {
        session,
        attempt: 'app',
        bundleId: 'dev.sample.stim.test',
        mode: 'release',
        manifest: { sha256: sha(manifest), size: manifest.length },
      };
      const handoff = (build: { handoff: string; sha256: string }) =>
        hosting.request('device-host.app.handoff', { session, attempt: 'app', build });
      await hosting.request('device-host.app.offer', app);
      expect(await handoff(own.build)).toHaveProperty('error.message', expect.stringContaining('manifest'));
      await hosting.request('device-host.app.chunk', {
        session,
        attempt: 'app',
        sha256: sha(manifest),
        offset: 0,
        data: Buffer.from(manifest).toString('base64'),
      });
      expect(await hosting.request('device-host.app.offer', app)).toHaveProperty('result.missing.length', 5);

      expect(await handoff(elsewhere.build)).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('different keys') },
      });
      expect(existsSync(join(elsewhere.out, 'App.app'))).toBe(true);
      expect(revokeDevice(revoked.id)).toBe(true);
      await eventually(() => !existsSync(revoked.out));
      expect(await handoff(revoked.build)).toHaveProperty('error.code', 'action-failed');
      expect(await handoff({ ...own.build, sha256: 'c'.repeat(64) })).toHaveProperty('error.code', 'action-failed');
      const contents = join(own.out, 'App.app', 'Contents');
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'Info.plist'), 'plist bytes');
      writeFileSync(join(outside, 'Sample'), 'binary bytes');
      rmSync(join(contents, 'Info.plist'));
      symlinkSync(join(outside, 'Info.plist'), join(contents, 'Info.plist'));
      rmSync(join(contents, 'MacOS'), { recursive: true });
      symlinkSync(outside, join(contents, 'MacOS'));
      writeFileSync(join(contents, 'data'), 'DATA bytes');
      expect(await handoff(own.build)).toHaveProperty('result', {
        files: 2,
        bytes: 'MacOS'.length + 'APPL????'.length,
      });
      expect(existsSync(own.out)).toBe(false);
      expect(await handoff(own.build)).toHaveProperty('error.message', expect.stringContaining('no longer holds'));
      const blobs = join(deviceHostArea(session), 'blobs');
      expect(readFileSync(join(blobs, sha('APPL????')), 'utf8')).toBe('APPL????');
      expect(readFileSync(join(blobs, sha('MacOS')), 'utf8')).toBe('MacOS');
      const offered = await hosting.request('device-host.app.offer', app);
      expect(
        (offered as { result: { missing: { sha256: string }[] } }).result.missing.map((each) => each.sha256).toSorted(),
      ).toEqual([sha('plist bytes'), sha('binary bytes'), sha('data bytes')].toSorted());
    },
  );

  test.skipIf(!fakeTailscale)(
    'Android handoff checks same-node approvals, archive digest and APK-only manifest before copying verified bytes',
    async () => {
      const port = await startWorker();
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
      import {writeFileSync} from 'node:fs';import {join} from 'node:path';
      const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const device={avdName:'stim-hosted-'+input.session,serial:'emulator-'+input.consolePort,consolePort:input.consolePort,
        systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'};
      if(input.mode==='prepare') {
        writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[],android:[device.avdName],web:[]}));
      }
      if(input.mode==='stop')writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[],android:[],web:[]}));
      process.stdout.write(JSON.stringify({state:input.mode==='prepare'||input.mode==='image'?'ready':'stopped',device}));
    `,
      );
      const machine = setupClient(['build', 'device-host'], 'Android hosting client');
      const elsewhere = await nativeBuild(port, '100.64.0.2', 'android');
      const own = await nativeBuild(port, '100.64.0.2', 'android', machine);
      expect(existsSync(join(own.out, 'App.apk'))).toBe(true);
      const hosting = await returning(port, machine.keyPair, '100.64.0.2', 'device-host');
      const reserved = await hosting.request('device-host.reserve', {
        workspace: '/client/app',
        slot: 'default',
        platform: 'android',
        attempt: 'handoff',
      });
      const session = (reserved as { result: { id: string } }).result.id;
      await vi.waitFor(async () =>
        expect(await hosting.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const offer = async (attempt: string, files: object[]) => {
        const manifest = JSON.stringify(files);
        const app = {
          session,
          attempt,
          bundleId: 'dev.fixture',
          mode: 'release',
          manifest: { sha256: sha(manifest), size: manifest.length },
        };
        await hosting.request('device-host.app.offer', app);
        await hosting.request('device-host.app.chunk', {
          session,
          attempt,
          sha256: sha(manifest),
          offset: 0,
          data: Buffer.from(manifest).toString('base64'),
        });
        return app;
      };
      const handoff = (build: { handoff: string; sha256: string }) =>
        hosting.request('device-host.app.handoff', { session, attempt: 'app', build });
      const app = await offer('app', [{ ...file('App.apk', 'APK bytes'), kind: 'file' }]);
      expect(await handoff(elsewhere.build)).toHaveProperty('error.message', expect.stringContaining('different keys'));
      expect(await handoff({ ...own.build, sha256: 'c'.repeat(64) })).toHaveProperty('error.code', 'action-failed');
      expect(await handoff(own.build)).toHaveProperty('result', { files: 1, bytes: 9 });
      expect(await hosting.request('device-host.app.offer', app)).toHaveProperty('result.missing', []);
      expect(readFileSync(join(deviceHostArea(session), 'blobs', sha('APK bytes')), 'utf8')).toBe('APK bytes');
      expect(existsSync(own.out)).toBe(false);
      expect(await handoff(own.build)).toHaveProperty('error.code', 'action-failed');
    },
  );

  test.skipIf(!fakeTailscale)('deletes a fetched macOS build nobody takes once its handoff lapses', async () => {
    const port = await startWorker({ buildLimits: { handoffMs: 50, daemonSweepMs: 50 } });
    const { out } = await nativeBuild(port, '100.64.0.2');
    await eventually(() => !existsSync(out));
  });

  test.skipIf(!fakeTailscale)(
    'declines an offer and a start while its own native builds fill concurrency.maxBuilds',
    async () => {
      configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
      const building = join(root, 'building');
      mkdirSync(building);
      const attempt = tryAcquireClaim({ root: join(root, 'native-run'), mode: 'exclusive', label: 'native run' });
      const claim = attempt.acquired!;
      mkdirSync(workspaceStateDir(building), { recursive: true });
      const writeActive = (phase: string) =>
        writeFileSync(
          join(workspaceStateDir(building), 'state.json'),
          JSON.stringify({ activeBuild: { phase, claim: { root: claim.root, claimId: claim.claimId } } }),
        );
      writeActive('install');
      const port = await startWorker();
      const { client } = await buildClient(port);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: {
          capacity: {
            builds: 0,
            maxBuilds: 1,
            declined: null,
            cpus: expect.any(Number),
            memoryTotalBytes: expect.any(Number),
            memoryUsedBytes: expect.toSatisfy((bytes: number) => bytes > 0),
          },
        },
      });

      writeActive('compile');
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 0, builds: 1, maxBuilds: 1, declined: 'all 1 build slots busy' } },
      });
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: {
          code: 'build-busy',
          message: expect.stringMatching(
            /^This machine declines the build: all 1 build slots busy \(load [\d.]+\/core, \d offloaded build\(s\) running, [\d.]+ GB free\)\.$/,
          ),
        },
      });

      releaseClaim(claim);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { builds: 0, declined: null } },
      });
    },
  );

  test.skipIf(!fakeTailscale)(
    'holds one of its build slots for the whole offloaded build, and refuses a start while local runs hold them all',
    async () => {
      configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
      const local = tryAcquireBuildSlotClaim({ max: 1, details: { projectRoot: root } })!;
      const port = await startWorker({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({
        error: {
          code: 'build-busy',
          message: expect.stringMatching(
            /^This machine declines the build: all 1 build slots busy \(load [\d.]+\/core, \d offloaded build\(s\) running, [\d.]+ GB free\)\.$/,
          ),
        },
      });

      releaseClaim(local.claim);
      const started = await client.request('build.start', START);
      expect(started).toMatchObject({ result: { job: expect.any(String) } });
      const job = (started as { result: { job: string } }).result.job;
      await eventually(() => existsSync(join(root, 'job.json')));
      const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
      expect(await client.next()).toMatchObject({ phase: 'build' });
      expect(await client.next()).toMatchObject({ record: { msg: 'CompileC' } });
      expect(readClaimSet(buildSlotPath(0)).live).toMatchObject([
        { details: { offloaded: true, client: id, repo: 'app-1', job, index: 0 }, childDeclared: true, child: null },
      ]);
      expect(tryAcquireBuildSlotClaim({ max: 1, details: {} })).toBeNull();
      expect(machineCapacity().builds).toBe(1);
      expect(await client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 1, builds: 1, maxBuilds: 1 } },
      });

      expect(await client.request('build.cancel', { job })).toEqual({ id: expect.anything(), result: {} });
      await eventually(() => !alive(pid));
      const held = readClaimSet(buildSlotPath(0));
      expect(held.live.length + held.unresolved.length).toBeGreaterThan(0);
    },
  );

  test.skipIf(!fakeTailscale)(
    'keeps a build running when its connection drops and hands it to a new connection of the same client',
    async () => {
      const gate = join(root, 'gate');
      const port = await startWorker({ env: { FAKE_WORKER_GATE: gate } });
      const { client, keyPair, spliced } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;
      expect(await client.next()).toMatchObject({ phase: 'build' });
      client.socket.terminate();
      expect(await client.closed).toBe(1006);

      const other = await buildClient(port, '100.64.0.3', undefined, false);
      expect(await other.client.request('job.start', { attach: spliced })).toMatchObject({
        error: { code: 'bad-request' },
      });

      const again = await returning(port, keyPair, '100.64.0.2', 'build');
      expect(await again.request('job.start', { attach: spliced })).toMatchObject({ result: { job: spliced } });
      expect(await again.request('build.attach', { job })).toEqual({ id: 3, result: { outcome: null } });
      writeFileSync(gate, '');
      expect((await progress(again)).at(-1)).toMatchObject({ job, outcome: { ok: true } });
      again.socket.send(JSON.stringify({ id: 4, method: 'build.artifact', params: { job } }));
      expect(((await again.next()) as unknown as { binary: Buffer }).binary.subarray(32).toString()).toBe(
        'app archive bytes',
      );
      expect(await again.next()).toMatchObject({ id: 4, result: { name: 'App.app' } });
    },
  );

  test.skipIf(!fakeTailscale)(
    'moves a build off a connection that is still open, so closing that one does not cancel it',
    async () => {
      const gate = join(root, 'gate');
      const port = await startWorker({ env: { FAKE_WORKER_GATE: gate } });
      const { client, keyPair, spliced } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const job = ((await client.request('build.start', START)) as { result: { job: string } }).result.job;

      const again = await returning(port, keyPair, '100.64.0.2', 'build');
      expect(await again.request('job.start', { attach: spliced })).toMatchObject({ result: { job: spliced } });
      expect(await again.request('build.attach', { job })).toEqual({ id: 3, result: { outcome: null } });
      client.socket.close(1000);
      expect(await client.closed).toBe(1000);
      writeFileSync(gate, '');
      expect((await progress(again)).at(-1)).toMatchObject({ job, outcome: { ok: true } });
    },
  );

  test.skipIf(!fakeTailscale)('cancels a detached build when its client is revoked', async () => {
    const port = await startWorker({
      env: { FAKE_WORKER_HANG: '1' },
      buildLimits: { killGraceMs: 100, detachGraceMs: 60_000 },
    });
    const { client, id } = await buildClient(port);
    await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
    client.socket.send(blob('x'));
    expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
    await eventually(() => existsSync(join(root, 'job.json')));
    const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
    client.socket.terminate();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(true);
    expect(revokeDevice(id)).toBe(true);
    await eventually(() => !alive(pid));
  });

  test.skipIf(!fakeTailscale)(
    'cancels a build at once when its connection closes cleanly, and after the grace period when it drops',
    async () => {
      configure({ server: { maxLoadPerCore: 100_000 }, concurrency: { maxBuilds: 2 } });
      const port = await startWorker({
        env: { FAKE_WORKER_HANG: '1' },
        buildLimits: { killGraceMs: 100, detachGraceMs: 1500 },
      });
      const pidOf = async () => {
        await eventually(() => existsSync(join(root, 'job.json')));
        const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
        rmSync(join(root, 'job.json'));
        return pid;
      };
      const run = async () => {
        const { client } = await buildClient(port);
        await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
        client.socket.send(blob('x'));
        expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
        return { client, pid: await pidOf() };
      };

      const closing = await run();
      closing.client.socket.close(1000);
      await eventually(() => !alive(closing.pid));

      const dropping = await run();
      const dropped = Date.now();
      dropping.client.socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(alive(dropping.pid)).toBe(true);
      await eventually(() => !alive(dropping.pid));
      expect(Date.now() - dropped).toBeGreaterThanOrEqual(1500);
    },
  );

  test.skipIf(!fakeTailscale)(
    'refuses paths outside the mirror, and closes the connection on a blob it did not ask for or whose bytes differ',
    async () => {
      const port = await startWorker();
      const { client } = await buildClient(port);
      for (const path of ['../escape', '/abs', 'a/./b', '.GIT/config', 'a//b']) {
        expect(
          await client.request('build.sync', { repo: 'app-1', files: [file(path, 'x')], done: true }),
        ).toMatchObject({
          error: { code: 'bad-request' },
        });
      }
      client.socket.send(blob('unasked'));
      expect(await client.closed).toBe(4400);

      const { client: again } = await buildClient(port);
      await again.request('build.sync', { repo: 'app-1', files: [file('a', 'right')], done: true });
      again.socket.send(Buffer.concat([Buffer.from(sha('right'), 'hex'), Buffer.from('wrong')]));
      expect(await again.closed).toBe(4400);
    },
  );

  test.skipIf(!fakeTailscale)('declines an offloaded build past server.maxOffloadedBuilds', async () => {
    configure({ server: { maxLoadPerCore: 100_000, maxOffloadedBuilds: 1 } });
    const port = await startWorker({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
    const { client } = await buildClient(port);
    await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
    client.socket.send(blob('x'));
    expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });

    const other = await buildClient(port, '100.64.0.3');
    expect(await other.client.request('build.offer', { repo: 'app-2' })).toMatchObject({
      result: {
        capacity: {
          running: 1,
          max: 1,
          declined: 'already running 1 offloaded build(s), its server.maxOffloadedBuilds limit',
        },
      },
    });
  });

  test.each([false, true])(
    'stops a revoked build and retains its unresolved claim with watch events dropped: %s',
    { skip: !fakeTailscale },
    async (dropEvents) => {
      registryWatch.dropEvents = dropEvents;
      configure({ server: { maxLoadPerCore: 100_000 }, concurrency: { maxBuilds: 2 } });
      const port = await startWorker({ env: { FAKE_WORKER_HANG: '1' }, buildLimits: { killGraceMs: 100 } });
      const { client, id } = await buildClient(port);
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      expect(await client.request('build.start', START)).toMatchObject({ result: { job: expect.any(String) } });
      await eventually(() => existsSync(join(root, 'job.json')));
      const { pid } = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')) as { pid: number };
      const area = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1');
      expect(readClaimSet(`${area}.claims`).live).toHaveLength(1);

      const other = await buildClient(port, '100.64.0.3');
      expect(await other.client.request('build.offer', { repo: 'app-1' })).toMatchObject({
        result: { capacity: { running: 1, max: 0, declined: null } },
      });

      expect(revokeDevice(id)).toBe(true);
      expect(await client.closed).toBe(4401);
      await eventually(() => !alive(pid));
      const held = readClaimSet(`${area}.claims`);
      expect(held.live.length + held.unresolved.length).toBeGreaterThan(0);
      expect(existsSync(area)).toBe(true);
    },
  );

  describe('warm Gradle daemons', () => {
    const daemons: ChildProcess[] = [];
    const gradleHome = (client: string, repo?: string, node = 'n0123456789ab') =>
      join(
        process.env.STIM_HOME!,
        'build-worker',
        client,
        ...(repo ? ['repos', repo] : []),
        'cache',
        'gradle',
        ...(repo ? [node] : []),
      );
    const daemonOf = (client: string, repo?: string, node?: string, ignoresTerm = false) => {
      const jar = join(
        gradleHome(client, repo, node),
        'wrapper',
        'dists',
        'gradle-9.4.1',
        'lib',
        'gradle-daemon-main-9.4.1.jar',
      );
      mkdirSync(gradleHome(client, repo, node), { recursive: true });
      const daemon = spawn(
        process.execPath,
        [
          '-e',
          `${ignoresTerm ? "process.on('SIGTERM', () => {}); process.stdout.write('ready');" : ''} setInterval(() => {}, 1000)`,
          jar,
          'org.gradle.launcher.daemon.bootstrap.GradleDaemon',
        ],
        { stdio: ignoresTerm ? ['ignore', 'pipe', 'ignore'] : 'ignore' },
      );
      daemons.push(daemon);
      return daemon;
    };
    const running = (daemon: ChildProcess) => daemon.exitCode === null && daemon.signalCode === null;
    const android = { variant: null, abi: 'arm64-v8a', gradleBuildCache: true, pch: 'auto', compilerCache: 'ccache' };
    const ANDROID_START = { ...START, platform: 'android', runtime: null, android };
    const launch = async (client: Client) => {
      await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
      client.socket.send(blob('x'));
      const started = await client.request('build.start', ANDROID_START);
      return (started as { result: { job: string } }).result.job;
    };

    afterEach(() => {
      for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL');
    });

    test.skipIf(!fakeTailscale)(
      'leaves daemon idle policy to Gradle, and stops an idle one once its client is revoked',
      async () => {
        configure({ server: { maxLoadPerCore: 100_000, gradleDaemonIdleMinutes: 45 } });
        const port = await startWorker({ buildLimits: { daemonSweepMs: 50, minFreeMemoryBytes: 0 } });
        const { client, id } = await buildClient(port);
        await launch(client);
        await progress(client);
        const ran = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8'));
        expect(ran.job).not.toHaveProperty('gradleDaemonIdleMs');

        const other = await buildClient(port, '100.64.0.3');
        const kept = daemonOf(other.id);
        const revoked = daemonOf(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(running(kept) && running(revoked)).toBe(true);
        expect(revokeDevice(id)).toBe(true);
        await eventually(() => !running(revoked));
        expect(running(kept)).toBe(true);
      },
    );

    test.skipIf(!fakeTailscale)(
      'defers low-memory daemon stops until no client is building, while still stopping revoked clients',
      async () => {
        const gate = join(root, 'gate');
        const port = await startWorker({
          env: { FAKE_WORKER_GATE: gate },
          buildLimits: { daemonSweepMs: 50, minFreeMemoryBytes: Number.MAX_SAFE_INTEGER },
        });
        const { client, id } = await buildClient(port);
        const other = await buildClient(port, '100.64.0.3');
        const revokedClient = await buildClient(port, '100.64.0.4');
        await launch(client);
        const building = daemonOf(id);
        const idle = daemonOf(other.id);
        const revoked = daemonOf(revokedClient.id);
        expect(revokeDevice(revokedClient.id)).toBe(true);
        await eventually(() => !running(revoked));
        expect(running(building) && running(idle)).toBe(true);
        writeFileSync(gate, '');
        expect((await progress(client)).at(-1)).toMatchObject({ outcome: { ok: true } });
        await eventually(() => !running(building) && !running(idle));
      },
    );

    test.each(['cancelled', 'worker-crashed'] as const)(
      'stops only the failed repository daemon after %s',
      { skip: !fakeTailscale },
      async (reason) => {
        configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
        const gate = join(root, 'crash-gate');
        const port = await startWorker({
          env: reason === 'cancelled' ? { FAKE_WORKER_HANG: '1' } : { FAKE_WORKER_GATE: gate, FAKE_WORKER_CRASH: '1' },
          buildLimits: { killGraceMs: 100, minFreeMemoryBytes: 0 },
        });
        const { client, id } = await buildClient(port);
        const job = await launch(client);
        const daemon = daemonOf(id, 'app-1', undefined, reason === 'cancelled');
        const priorNode = daemonOf(id, 'app-1', 'nfedcba987654');
        const sibling = daemonOf(id, 'another-repo');
        let settling: ChildProcess | undefined;
        if (reason === 'cancelled') {
          assert(daemon.stdout);
          await once(daemon.stdout, 'data');
          settling = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdout.write('ready')"], {
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          daemons.push(settling);
          assert(settling.stdout);
          await once(settling.stdout, 'data');
          assert(settling.pid);
          const logs = join(gradleHome(id, 'app-1'), 'daemon', '9.4.1');
          mkdirSync(logs, { recursive: true });
          writeFileSync(join(logs, `daemon-${settling.pid}.out.log`), '');
          daemon.once('exit', () => settling?.stdin?.end());
          const response = await client.request('build.cancel', { job });
          assert('result' in response);
          assert.deepStrictEqual(response.result, {});
        } else writeFileSync(gate, '');
        expect((await progress(client)).at(-1)).toMatchObject({ outcome: { ok: false, code: 'cleanup-unresolved' } });
        await eventually(() => !running(daemon));
        expect(running(priorNode)).toBe(false);
        assert(!settling || (settling.exitCode === 0 && settling.signalCode === null));
        expect(running(sibling)).toBe(true);
        if (reason === 'worker-crashed') {
          await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
          const refused = await client.request('build.start', ANDROID_START);
          assert('error' in refused && refused.error.code === 'build-busy');
          const stimHome = process.env.STIM_HOME;
          assert(stimHome);
          const area = join(stimHome, 'build-worker', id, 'repos', 'app-1');
          const areaClaim = readClaimSet(`${area}.claims`);
          const slotClaim = readClaimSet(buildSlotPath(0));
          assert(areaClaim.live.length + areaClaim.unresolved.length > 0);
          assert(slotClaim.live.length + slotClaim.unresolved.length > 0);
        }
      },
    );

    test.skipIf(!fakeTailscale)(
      'retains the failed build claims when a Gradle daemon cannot be classified',
      async () => {
        configure({ concurrency: { maxBuilds: 1 }, server: { maxLoadPerCore: 100_000 } });
        const port = await startWorker({
          env: { FAKE_WORKER_CRASH: '1' },
          buildLimits: { killGraceMs: 100, minFreeMemoryBytes: 0 },
        });
        const { client, id } = await buildClient(port);
        const unclassified = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        daemons.push(unclassified);
        await once(unclassified, 'spawn');
        assert(unclassified.pid);
        const logs = join(gradleHome(id, 'app-1'), 'daemon', '9.4.1');
        mkdirSync(logs, { recursive: true });
        writeFileSync(join(logs, `daemon-${unclassified.pid}.out.log`), '');
        await client.request('build.sync', { repo: 'app-1', files: [file('a', 'x')], done: true });
        client.socket.send(blob('x'));
        assert('result' in (await client.request('build.start', ANDROID_START)));
        const outcome = (await progress(client)).at(-1)?.outcome;
        assert(isJsonObject(outcome));
        assert.equal(outcome.code, 'cleanup-unresolved');
        const area = join(process.env.STIM_HOME!, 'build-worker', id, 'repos', 'app-1');
        expect(readClaimSet(`${area}.claims`).live.length).toBe(1);
        expect(readClaimSet(buildSlotPath(0)).live.length).toBe(1);
        expect(running(unclassified)).toBe(true);
      },
    );
  });
});
