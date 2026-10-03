import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createMetroGateway } from '@stim-cli/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceHostArea, deviceHostRoot, readHostedSessions } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { DeviceHost } from '../src/device-host.ts';
import { HostedViews } from '../src/hosted-view.ts';
import { ControlHub } from '../src/control.ts';
import { FramePool } from '../src/frames.ts';
import { FeedPool } from '../src/feed.ts';
import type { ServerMessage } from '../src/protocol.ts';

const WORKER = `
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks));
const home = process.env.STIM_HOME;
const device = {udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
const out = value => process.stdout.write(JSON.stringify(value));
if(input.mode === 'prepare') {
  writeFileSync(join(home,'entered'),String(process.pid));
  if(input.deviceType === 'refused' || input.deviceType === 'delayed-refusal') {
    if(input.deviceType === 'delayed-refusal') await new Promise(resolve=>setTimeout(resolve,150));
    out({state:'stopped',device:null,notice:'inventory unavailable'});
  }
  else {
    writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
    writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
    if(input.deviceType === 'descendant') {
      spawn(process.execPath,['--input-type=module','-e',
        "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.env.STIM_HOME+'/descendant',String(process.pid)); setInterval(()=>{},1000);"
      ],{stdio:'ignore'});
      setInterval(()=>{},1000);
    }
    else if(input.deviceType === 'hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
    else if(input.deviceType === 'lost') { process.exitCode=1; }
    else out({state:'ready',device});
  }
} else if(input.mode === 'install') {
  appendFileSync(join(home,'installed'),input.attempt+'\\n');
  const stored=JSON.parse(readFileSync(join(home,'hosted-device.json'),'utf8'));
  const app=JSON.parse(readFileSync(join(home,'..','apps',input.attempt,'receipt.json'),'utf8'));
  if(input.deviceType === 'install-hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else out({state:'installed',device:stored,launched:app.mode === 'release' ? true : 'unverified'});
} else {
  writeFileSync(join(home,'stopped'),String(process.pid));
  const stored=JSON.parse(readFileSync(join(home,'hosted-device.json'),'utf8'));
  out({state:input.deviceType === 'uncertain-stop'?'unknown':'stopped',device:stored});
}
`;
let home: string;
let host: DeviceHost;
let allowed: Set<string>;
const request = { workspace: '/client/worktree', slot: 'default', platform: 'ios', attempt: 'first' };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-hosted-test-'));
  process.env.STIM_HOME = home;
  const worker = join(home, 'worker.mjs');
  writeFileSync(worker, WORKER);
  allowed = new Set(['client', 'other']);
  host = new DeviceHost({
    worker,
    env: { ...process.env, STIM_MAX_DEVICES: '1' },
    allowed: (client) => allowed.has(client),
    limits: { prepareMs: 5000, stopMs: 2000, killGraceMs: 100 },
  });
});
afterEach(async () => {
  await host.close();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function reserve(extra = {}) {
  const answer = host.reserve('client', { ...request, ...extra });
  if ('error' in answer) throw new Error(answer.error.message);
  return answer.result;
}

async function state(id: string, wanted: string) {
  await vi.waitFor(() => expect(readHostedSessions().find((record) => record.id === id)?.state).toBe(wanted), {
    timeout: 5000,
  });
  return readHostedSessions().find((record) => record.id === id)!;
}

test('keeps HTTP and WebSocket Metro on the owned session port across reconnect and closes it on revocation', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  const metro = createServer((_request, response) => response.end('workspace bundle'));
  const messages = new WebSocketServer({ server: metro });
  messages.on('connection', (socket) => socket.on('message', (message) => socket.send(message)));
  await new Promise<void>((resolve) => metro.listen(0, '127.0.0.1', resolve));
  const secret = 'a'.repeat(64);
  const gateway = createMetroGateway({ metroPort: (metro.address() as AddressInfo).port, peer: '127.0.0.1', secret });
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const params = { session: first.id, gatewayPort: (gateway.server.address() as AddressInfo).port, secret };
  let client: WebSocket | undefined;
  try {
    expect(await host.metroOpen('other', params, '127.0.0.1')).toHaveProperty('error');
    expect(await host.metroOpen('client', params, null)).toHaveProperty('error.code', 'bad-request');
    const opened = await host.metroOpen('client', params, '127.0.0.1');
    if ('error' in opened) throw new Error(opened.error.message);
    const port = opened.result.port;
    expect(await (await fetch(`http://127.0.0.1:${port}/index.bundle`)).text()).toBe('workspace bundle');
    expect(await host.metroOpen('client', params, '127.0.0.1')).toHaveProperty('result.port', port);
    expect(await host.metroOpen('client', { ...params, secret: 'b'.repeat(64) }, '127.0.0.1')).toHaveProperty('error');
    expect(await host.metroClose('other', params)).toHaveProperty('error.code', 'unknown-session');
    expect(await host.metroClose('client', params)).toHaveProperty('result.port', null);
    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow('fetch failed');
    expect(await host.metroOpen('client', params, '127.0.0.1')).toHaveProperty('result.port', port);
    client = new WebSocket(`ws://127.0.0.1:${port}/message`);
    await new Promise<void>((resolve, reject) => {
      client!.once('open', resolve);
      client!.once('error', reject);
    });
    const packet = JSON.stringify({ version: 2, method: 'reload' });
    const echo = new Promise<string>((resolve) => client!.once('message', (message) => resolve(message.toString())));
    client.send(packet);
    expect(await echo).toBe(packet);
    const closed = new Promise<void>((resolve) => client!.once('close', () => resolve()));
    allowed.delete('client');
    host.revoke();
    await closed;
    await state(first.id, 'stopped');
    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow('fetch failed');
    expect(await (await fetch(`http://127.0.0.1:${(metro.address() as AddressInfo).port}/status`)).text()).toBe(
      'workspace bundle',
    );
  } finally {
    client?.terminate();
    await gateway.close();
    messages.close();
    metro.closeAllConnections();
    await new Promise<void>((resolve) => metro.close(() => resolve()));
  }
});

for (const ending of ['revocation', 'server close', 'revocation with an unwritable journal']) {
  test.skipIf(ending === 'revocation with an unwritable journal' && process.platform === 'win32')(
    `closes known Metro traffic on ${ending} when journal reconciliation fails and retains its device claim`,
    async () => {
      const first = reserve();
      await state(first.id, 'ready');
      const metro = createServer((_request, response) => response.end('private workspace bundle'));
      await new Promise<void>((resolve) => metro.listen(0, '127.0.0.1', resolve));
      const secret = 'a'.repeat(64);
      const gateway = createMetroGateway({
        metroPort: (metro.address() as AddressInfo).port,
        peer: '127.0.0.1',
        secret,
      });
      await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
      const journal = join(deviceHostRoot(), 'sessions.json');
      const original = readFileSync(journal, 'utf8');
      try {
        const opened = await host.metroOpen(
          'client',
          { session: first.id, gatewayPort: (gateway.server.address() as AddressInfo).port, secret },
          '127.0.0.1',
        );
        if ('error' in opened) throw new Error(opened.error.message);
        const url = `http://127.0.0.1:${opened.result.port}/index.bundle`;
        expect(await (await fetch(url)).text()).toBe('private workspace bundle');
        if (ending === 'revocation with an unwritable journal') chmodSync(deviceHostRoot(), 0o500);
        else writeFileSync(journal, '{}');
        if (ending !== 'server close') {
          allowed.delete('client');
          host.revoke();
        } else await host.close();
        await vi.waitFor(async () => expect(fetch(url)).rejects.toThrow('fetch failed'));
        expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live).toHaveLength(1);
        expect(existsSync(join(deviceHostArea(first.id), 'home', 'stopped'))).toBe(false);
      } finally {
        chmodSync(deviceHostRoot(), 0o700);
        writeFileSync(journal, original);
        await gateway.close();
        metro.closeAllConnections();
        await new Promise<void>((resolve) => metro.close(() => resolve()));
      }
    },
  );
}
describe.skipIf(process.platform === 'win32')('hosted capture journal failures', () => {
  test.each(['revocation', 'server close', 'unwritable revocation'])(
    'closes actual capture and input on %s and retains unresolved native ownership',
    async (ending) => {
      const first = reserve();
      await state(first.id, 'ready');
      const helper = join(home, 'capture-helper');
      writeFileSync(
        helper,
        `#!${process.execPath}
const header=Buffer.alloc(9);header.writeUInt32BE(6);header[4]=1;header.writeUInt16BE(1,5);header.writeUInt16BE(1,7);
process.stdout.write(Buffer.concat([header,Buffer.from('x')]));
process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,
      );
      chmodSync(helper, 0o755);
      const frames = new FramePool(process.env);
      const feeds = new FeedPool(join(home, 'unused-cli.mjs'), process.env);
      const sent: ServerMessage[] = [];
      const control = new ControlHub({
        env: process.env,
        stimCli: join(home, 'unused-cli.mjs'),
        feeds,
        frames,
        statusFeed: { args: ['status', '--watch', '--json'], cwd: home, keep: 1, label: 'unused status' },
        audit: () => {},
        lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
        idleMs: 60_000,
        renewMs: 60_000,
        leaseFor: '1m',
        foldHelper: async () => helper,
        foldTimeoutMs: 1000,
        conflict: () => {},
      });
      const views = new HostedViews(host, control, process.env, () => helper);
      const failed: string[] = [];
      let firstFrame!: () => void;
      const captured = new Promise<void>((resolve) => (firstFrame = resolve));
      views.subscribe(
        'client',
        first.id,
        { frame: () => firstFrame(), delayed: () => {}, failed: (message) => failed.push(message) },
        { fps: 5, maxEdge: 480 },
      );
      await captured;
      const owner = { device: { id: 'client', name: 'Client' }, send: (message: ServerMessage) => sent.push(message) };
      const begun = await views.begin('client', first.id, owner, false, () => true);
      if ('code' in begun) throw new Error(begun.message);
      const claims = join(deviceHostRoot(), `${first.id}.claims`);
      const capture = readClaimSet(claims).live[0]!.child;
      expect(capture).not.toBeNull();
      const journal = join(deviceHostRoot(), 'sessions.json');
      const original = readFileSync(journal, 'utf8');
      try {
        if (ending === 'unwritable revocation') chmodSync(deviceHostRoot(), 0o500);
        else writeFileSync(journal, '{}');
        if (ending === 'server close') await host.close();
        else {
          allowed.delete('client');
          host.revoke();
        }
        await vi.waitFor(() => expect(readClaimSet(claims).live[0]!.child).toBeNull(), { timeout: 3000 });
        expect(readClaimSet(claims).live).toHaveLength(1);
        expect(existsSync(join(deviceHostArea(first.id), 'home', 'stopped'))).toBe(false);
        expect(await control.input(owner, begun.session, { input: 'touch', phase: 'down', x: 0, y: 1 })).toMatchObject({
          code: 'unknown-session',
        });
        expect(failed).toHaveLength(1);
        expect(sent).toEqual(
          expect.arrayContaining([expect.objectContaining({ event: 'control-ended', session: begun.session })]),
        );
      } finally {
        chmodSync(deviceHostRoot(), 0o700);
        writeFileSync(journal, original);
        await control.close();
        await frames.close();
        await feeds.close();
      }
    },
  );
});

test('reserves once across reconnect and attempt replay, isolates clients, and stops only the owned session', async () => {
  const first = reserve();
  expect(first.state).toBe('preparing');
  expect(reserve().id).toBe(first.id);
  expect(host.reserve('client', { ...request, attempt: 'second' })).toHaveProperty('error.code', 'device-busy');
  expect(host.reserve('other', { ...request, attempt: 'other' })).toHaveProperty('error.code', 'device-busy');
  await state(first.id, 'ready');
  expect(host.attach('client', { attempt: 'first' })).toHaveProperty('result.id', first.id);
  expect(host.attach('other', { session: first.id })).toHaveProperty('error.code', 'unknown-session');
  expect(host.stop('other', { session: first.id })).toHaveProperty('error.code', 'unknown-session');
  expect(host.reserve('client', { ...request, workspace: '/different' })).toHaveProperty('error.code', 'device-busy');
  expect(host.stop('client', { session: first.id })).toHaveProperty('result.state', 'stopping');
  await state(first.id, 'stopped');
  expect(existsSync(join(deviceHostArea(first.id), 'home', 'stopped'))).toBe(true);
  expect(reserve().state).toBe('stopped');
  expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live).toEqual([]);
  expect(reserve({ attempt: 'new' }).id).not.toBe(first.id);
});

test('rejects malformed client identities and selectors before reserving a worker area', () => {
  for (const invalid of [
    { workspace: '/client\nworktree' },
    { slot: '__proto__' },
    { slot: '../other' },
    { platform: 'android' },
    { attempt: '../other' },
    { deviceType: 42 },
    { runtime: '' },
  ])
    expect(host.reserve('client', { ...request, ...invalid })).toHaveProperty('error.code', 'bad-request');
  expect(readHostedSessions()).toEqual([]);
});

test('another server reports the retained reservation as unknown and cannot stop its live owner', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  const other = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: process.env,
    allowed: () => true,
  });
  try {
    expect(other.attach('client', { attempt: request.attempt })).toHaveProperty('result.state', 'unknown');
    expect(other.reserve('client', request)).toHaveProperty('result.id', first.id);
    expect(other.stop('client', { session: first.id })).toHaveProperty('error.code', 'action-failed');
    expect(existsSync(join(deviceHostArea(first.id), 'home', 'stopped'))).toBe(false);
    expect(host.attach('client', { session: first.id })).toHaveProperty('result.state', 'ready');
  } finally {
    await other.close();
  }
});

test('keeps the server responsive and bounds cancellation of a TERM-resistant actual worker', async () => {
  const first = reserve({ deviceType: 'hang' });
  const file = join(deviceHostArea(first.id), 'home', 'entered');
  await vi.waitFor(() => expect(existsSync(file)).toBe(true));
  const pid = Number(readFileSync(file, 'utf8'));
  expect(host.attach('client', { session: first.id })).toHaveProperty('result.state', 'preparing');
  host.stop('client', { session: first.id });
  await state(first.id, 'stopped');
  expect(processGroupAlive(pid)).toBe(false);
});

test.each(['stop', 'revoke'])('releases a preflight refusal when %s precedes its close callback', async (action) => {
  const first = reserve({ deviceType: 'delayed-refusal' });
  const area = join(deviceHostArea(first.id), 'home');
  await vi.waitFor(() => expect(existsSync(join(area, 'entered'))).toBe(true));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  if (action === 'stop') host.stop('client', { session: first.id });
  else {
    allowed.delete('client');
    host.revoke();
  }
  const declined = await state(first.id, 'stopped');
  expect(declined.device).toBeNull();
  expect(declined.notice).toBe('inventory unavailable');
  expect(existsSync(join(area, 'stopped'))).toBe(false);
  expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live).toEqual([]);
  expect(host.reserve('other', { ...request, attempt: 'next' })).toHaveProperty('result.state', 'preparing');
});

test('terminates a TERM-resistant descendant after the worker leader exits before releasing its claim', async () => {
  const first = reserve({ deviceType: 'descendant' });
  const area = join(deviceHostArea(first.id), 'home');
  await vi.waitFor(() => expect(existsSync(join(area, 'descendant'))).toBe(true));
  const leader = Number(readFileSync(join(area, 'entered'), 'utf8'));
  const descendant = Number(readFileSync(join(area, 'descendant'), 'utf8'));
  try {
    host.stop('client', { session: first.id });
    await state(first.id, 'stopped');
    expect(processGroupAlive(leader)).toBe(false);
    expect(() => process.kill(descendant, 0)).toThrow('ESRCH');
    expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live).toEqual([]);
  } finally {
    if (processGroupAlive(leader)) process.kill(-leader, 'SIGKILL');
  }
});

test('revocation stops a live owned device and rejects subsequent client methods', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  allowed.delete('client');
  host.revoke();
  await state(first.id, 'stopped');
  expect(host.attach('client', { session: first.id })).toHaveProperty('error.code', 'forbidden');
  expect(host.reserve('client', request)).toHaveProperty('error.code', 'forbidden');
});

test('a failed native preflight releases capacity but lost results and uncertain teardown retain it', async () => {
  const declined = reserve({ deviceType: 'refused' });
  await state(declined.id, 'stopped');
  const lost = reserve({ attempt: 'lost', deviceType: 'lost' });
  await state(lost.id, 'unknown');
  expect(host.reserve('other', request)).toHaveProperty('error.code', 'device-busy');
  host.stop('client', { session: lost.id });
  await state(lost.id, 'stopped');
  const uncertain = reserve({ attempt: 'uncertain', deviceType: 'uncertain-stop' });
  await state(uncertain.id, 'ready');
  host.stop('client', { session: uncertain.id });
  await state(uncertain.id, 'unknown');
  expect(host.reserve('other', request)).toHaveProperty('error.code', 'device-busy');
});

test('lost or malformed journal and device records fail closed without a second create', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  writeFileSync(join(deviceHostArea(first.id), 'home', 'hosted-device.json'), 'broken');
  host.stop('client', { session: first.id });
  await state(first.id, 'unknown');
  expect(existsSync(join(deviceHostArea(first.id), 'home', 'stopped'))).toBe(false);
  const journal = join(deviceHostRoot(), 'sessions.json');
  const original = readFileSync(journal, 'utf8');
  writeFileSync(journal, '{}');
  expect(host.reserve('client', { ...request, attempt: 'another' })).toHaveProperty('error');
  rmSync(journal);
  expect(host.attach('client', { session: first.id })).toHaveProperty('error.code', 'action-failed');
  writeFileSync(journal, original);
});

test('a lost journal directory cannot admit another device while a worker area remains', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  const backup = join(home, 'retained-journal');
  renameSync(deviceHostRoot(), backup);
  expect(host.reserve('client', { ...request, attempt: 'another' })).toHaveProperty('error');
  expect(host.attach('client', { session: first.id })).toHaveProperty('error.code', 'action-failed');
  renameSync(backup, deviceHostRoot());
});

function appOffer(session: string, attempt = 'app-first') {
  const content = Buffer.from('independent content for upload replay');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const files = [{ path: 'Info.plist', kind: 'file', size: content.length, sha256 }];
  const manifest = Buffer.from(JSON.stringify(files));
  return {
    content,
    sha256,
    manifest,
    params: {
      session,
      attempt,
      bundleId: 'dev.stim.fixture',
      mode: 'release',
      manifest: { size: manifest.length, sha256: createHash('sha256').update(manifest).digest('hex') },
    },
  };
}

async function uploadManifest(app: ReturnType<typeof appOffer>) {
  const result = await host.appChunk('client', {
    session: app.params.session,
    attempt: app.params.attempt,
    sha256: app.params.manifest.sha256,
    offset: 0,
    data: app.manifest.toString('base64'),
  });
  expect(result).toHaveProperty('result.offset', app.manifest.length);
}

test('refuses app mutations after the real session owner disappears until explicit stop reconciles it', async () => {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'device-host.ts')).href;
  const source = `
    import {DeviceHost} from ${JSON.stringify(module)};
    import {createHash} from 'node:crypto';
    const host=new DeviceHost({worker:${JSON.stringify(join(home, 'worker.mjs'))},env:process.env,allowed:()=>true});
    const reserved=host.reserve('client',${JSON.stringify(request)});
    if('error' in reserved) throw new Error(reserved.error.message);
    const session=reserved.result.id;
    while(host.attach('client',{session}).result?.state!=='ready') await new Promise(resolve=>setTimeout(resolve,10));
    const content=Buffer.from('retained app bytes');
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    const manifest=Buffer.from(JSON.stringify([{path:'Info.plist',kind:'file',size:content.length,sha256:hash(content)}]));
    const app={session,attempt:'retained-app',bundleId:'dev.stim.fixture',mode:'release',manifest:{size:manifest.length,sha256:hash(manifest)}};
    for(const result of [host.appOffer('client',app),
      await host.appChunk('client',{...app,sha256:hash(manifest),offset:0,data:manifest.toString('base64')}),
      await host.appChunk('client',{...app,sha256:hash(content),offset:0,data:content.toString('base64')})])
      if('error' in result) throw new Error(result.error.message);
    process.stdout.write(JSON.stringify({session,app,sha256:hash(content),data:content.toString('base64')}));
    process.exit(0);
  `;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      { env: process.env, timeout: 5000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  const retained = JSON.parse(output) as {
    session: string;
    app: ReturnType<typeof appOffer>['params'];
    sha256: string;
    data: string;
  };
  expect(readClaimSet(join(deviceHostRoot(), `${retained.session}.claims`)).live).toEqual([]);
  expect(host.attach('client', { session: retained.session })).toHaveProperty('result.state', 'unknown');
  expect(() => host.viewTarget('client', retained.session)).toThrow('Explicit stop');
  expect(host.appOffer('client', retained.app)).toHaveProperty(
    'error.message',
    expect.stringContaining('Explicit stop'),
  );
  expect(host.appOffer('client', { ...retained.app, attempt: 'replacement' })).toHaveProperty(
    'error.message',
    expect.stringContaining('Explicit stop'),
  );
  expect(
    await host.appChunk('client', { ...retained.app, sha256: retained.sha256, offset: 0, data: retained.data }),
  ).toHaveProperty('error.message', expect.stringContaining('Explicit stop'));
  expect(host.appLaunch('client', retained.app)).toHaveProperty(
    'error.message',
    expect.stringContaining('Explicit stop'),
  );
  expect(readHostedSessions()[0]?.appAttempt).toBe('retained-app');
  expect(existsSync(join(deviceHostArea(retained.session), 'home', 'installed'))).toBe(false);
  expect(host.stop('client', { session: retained.session })).toHaveProperty('result.state', 'stopping');
  await state(retained.session, 'stopped');
});

test('resumes verified app bytes and reconciles a lost install reply without another native launch', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  const app = appOffer(first.id);
  const { content, params, sha256 } = app;
  expect(host.appOffer('other', params)).toHaveProperty('error');
  expect(host.appOffer('client', params)).toHaveProperty('result.missing.0.offset', 0);
  expect(host.appLaunch('client', params)).toHaveProperty('error');
  expect(host.appOffer('client', { ...params, attempt: 'second-transfer' })).toHaveProperty('error');
  await uploadManifest(app);
  const firstChunk = {
    session: first.id,
    attempt: params.attempt,
    sha256,
    offset: 0,
    data: content.subarray(0, 10).toString('base64'),
  };
  expect(await host.appChunk('client', firstChunk)).toHaveProperty('result.offset', 10);
  expect(await host.appChunk('client', firstChunk)).toHaveProperty('result.offset', 10);
  expect(await host.appChunk('client', { ...firstChunk, data: Buffer.alloc(10).toString('base64') })).toHaveProperty(
    'error',
  );
  expect(host.appOffer('client', params)).toHaveProperty('result.missing.0.offset', 10);
  expect(
    await host.appChunk('client', { ...firstChunk, offset: 10, data: content.subarray(10).toString('base64') }),
  ).toHaveProperty('result.offset', content.length);
  expect(host.appOffer('client', params)).toHaveProperty('result.missing', []);
  expect(host.appOffer('client', { ...params, bundleId: 'different.app' })).toHaveProperty('error');
  expect(host.appLaunch('client', params)).toHaveProperty('result.state', 'installing');
  await vi.waitFor(() => expect(host.appAttach('client', params)).toHaveProperty('result.state', 'installed'));
  expect(host.appLaunch('client', params)).toHaveProperty('result.launched', true);
  expect(readFileSync(join(deviceHostArea(first.id), 'home', 'installed'), 'utf8')).toBe('app-first\n');
  expect(host.attach('client', { session: first.id })).toHaveProperty('result.appAttempt', params.attempt);
});

test('discards digest-mismatched app bytes and leaves native installation unstarted', async () => {
  const first = reserve();
  await state(first.id, 'ready');
  const app = appOffer(first.id);
  const { content, params, sha256 } = app;
  host.appOffer('client', params);
  await uploadManifest(app);
  expect(
    await host.appChunk('client', {
      session: first.id,
      attempt: params.attempt,
      sha256,
      offset: 0,
      data: Buffer.alloc(content.length).toString('base64'),
    }),
  ).toHaveProperty('error');
  expect(host.appOffer('client', params)).toHaveProperty('result.missing.0.offset', 0);
  expect(host.appLaunch('client', params)).toHaveProperty('error');
  expect(existsSync(join(deviceHostArea(first.id), 'home', 'installed'))).toBe(false);
});

test.each(['stop', 'revoke'])(
  '%s cancels an actual app worker before shutting down its exact device',
  async (action) => {
    const first = reserve({ deviceType: 'install-hang' });
    await state(first.id, 'ready');
    const app = appOffer(first.id);
    const { content, params, sha256 } = app;
    host.appOffer('client', params);
    await uploadManifest(app);
    await host.appChunk('client', {
      session: first.id,
      attempt: params.attempt,
      sha256,
      offset: 0,
      data: content.toString('base64'),
    });
    host.appLaunch('client', params);
    await vi.waitFor(() => expect(existsSync(join(deviceHostArea(first.id), 'home', 'installed'))).toBe(true));
    if (action === 'stop') host.stop('client', { session: first.id });
    else {
      allowed.delete('client');
      host.revoke();
    }
    await state(first.id, 'stopped');
    allowed.add('client');
    expect(host.appAttach('client', params)).toHaveProperty('result.state', 'unknown');
    expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live).toEqual([]);
  },
);
