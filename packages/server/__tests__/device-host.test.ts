import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createMetroGateway } from '@stim-cli/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceHostArea, deviceHostRoot, readHostedSessions } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet, tryAcquireClaim, releaseClaim } from '@stim-cli/core/ownership-claim';
import * as processIdentity from '@stim-cli/core/process-identity';
import { DeviceHost } from '../src/device-host.ts';
import { protocolJsonSchema, type ServerMessage } from '../src/protocol.ts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { HostedViews } from '../src/hosted-view.ts';
import { ControlHub } from '../src/control.ts';
import { FramePool } from '../src/frames.ts';
import { FeedPool } from '../src/feed.ts';

const WORKER = `
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks));
if(input.mode === 'offer') {
  const request=input;
  writeFileSync(join(process.env.STIM_HOME,'probe-entered'),String(process.pid));
  if(request.deviceType === 'delayed') await new Promise(resolve=>setTimeout(resolve,150));
  if(request.deviceType === 'sdk-hang') spawnSync(process.execPath,['--input-type=module','-e',
    "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.env.STIM_HOME+'/probe-descendant',String(process.pid)); setInterval(()=>{},1000);"
  ],{stdio:'ignore'});

  const declined=request.deviceType==='unavailable'?'SDK unavailable':request.deviceType==='empty-reason'?'':null;
  const choice=request.platform==='macos' ? {architecture:'arm64',macosVersion:'27.0'} : request.platform==='ios' ? {deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64',udid:'not-a-device'} : {systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'};
  process.stdout.write(JSON.stringify({platform:request.platform,choice:declined?null:choice,declined,resources:{cpus:4,loadPerCore:0.5,memoryFreeBytes:1000,memoryPressure:'normal',workerDiskFreeBytes:null}}));
  process.exit(0);
}
const home = process.env.STIM_HOME;
const iosDevice = {udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
const device = input.platform === 'macos' ? {architecture:'arm64',macosVersion:'27.0',appSlot:input.appSlot} : input.platform === 'android' ? {avdName:'stim-hosted-'+input.session,serial:'emulator-'+input.consolePort,consolePort:input.consolePort,systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'} : iosDevice;
const out = value => process.stdout.write(JSON.stringify(value));
if(input.mode === 'prepare') {
  writeFileSync(join(home,'entered'),String(process.pid));
  if(input.deviceType === 'refused' || input.deviceType === 'delayed-refusal') {
    if(input.deviceType === 'delayed-refusal') await new Promise(resolve=>setTimeout(resolve,150));
    out({state:'stopped',device:null,notice:'inventory unavailable'});
  }
  else {
    writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
    if(input.platform !== 'macos') writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:input.platform==='android'?[]:[device.udid],android:input.platform==='android'?[device.avdName]:[],web:[]}));
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
  writeFileSync(join(home,'install-metro-port'),String(input.metroPort ?? ''));
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
    const app = appOffer(first.id);
    host.appOffer('client', app.params);
    await uploadManifest(app);
    await host.appChunk('client', {
      ...app.params,
      sha256: app.sha256,
      offset: 0,
      data: app.content.toString('base64'),
    });
    expect(host.appLaunch('client', app.params)).toHaveProperty('result.state', 'installing');
    await vi.waitFor(() => expect(host.appAttach('client', app.params)).toHaveProperty('result.state', 'installed'));
    expect(readFileSync(join(deviceHostArea(first.id), 'home', 'install-metro-port'), 'utf8')).toBe(String(port));
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
        frameHelper: () => null,
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

test.each(['disconnect', 'takeover', 'timeout'])(
  'awaits the exact active fold before hosted device teardown after %s',
  { skip: process.platform === 'win32' },
  async (ending) => {
    const started = join(home, 'fold-started');
    const finished = join(home, 'fold-finished');
    const release = join(home, 'fold-release');
    const tool = join(home, 'xcrun');
    writeFileSync(
      tool,
      `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(started)},String(process.pid));
${ending === 'timeout' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'');}},10);`}
`,
    );
    chmodSync(tool, 0o755);
    const env = { ...process.env, PATH: `${home}:${process.env.PATH}` };
    const frames = new FramePool(env);
    const feeds = new FeedPool(join(home, 'unused-cli.mjs'), env);
    vi.spyOn(frames, 'control').mockReturnValue({ send: () => {}, keys: () => true, detach: () => {} });
    vi.spyOn(frames, 'litPosture').mockReturnValue('folded');
    vi.spyOn(frames, 'folded').mockImplementation(() => {});
    const control = new ControlHub({
      frameHelper: () => null,
      env,
      stimCli: join(home, 'unused-cli.mjs'),
      feeds,
      frames,
      statusFeed: { args: [], cwd: home, keep: 1, label: 'unused hosted status' },
      audit: () => {},
      lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
      idleMs: 60_000,
      renewMs: 60_000,
      leaseFor: '1m',
      foldHelper: async () => join(home, 'sim-fold'),
      foldTimeoutMs: ending === 'timeout' ? 500 : 5000,
      conflict: () => {},
    });
    const device = { platform: 'ios' as const, udid: 'owned-duo', foldable: true };
    const target = { workspace: '/client/worktree', platform: 'ios' as const };
    const owner = { device: { id: 'client', name: 'Client' }, send: () => {} };
    const claim = tryAcquireClaim({ root: join(home, 'input-owner.claims'), mode: 'exclusive' }).acquired!;
    const begun = await control.beginHosted(owner, target, home, device, frames, () => true, claim);
    if ('code' in begun) throw new Error(begun.message);
    const input = control.input(owner, begun.session, { input: 'posture', posture: 'unfolded' });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true));
      const pid = Number(readFileSync(started, 'utf8'));
      if (ending === 'takeover') {
        const replacement = { device: { id: 'client', name: 'Replacement' }, send: () => {} };
        const taken = await control.beginHosted(
          replacement,
          { ...target, takeOver: true },
          home,
          device,
          frames,
          () => true,
          claim,
        );
        if ('code' in taken) throw new Error(taken.message);
      } else control.endFor(owner, null, 'The client disconnected.');
      let ended = false;
      let waited = true;
      const teardown = control.endDevice(device, 'The hosted device is stopping.').then(() => (ended = true));
      if (ending !== 'timeout') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        waited = !ended;
        writeFileSync(release, '');
      }
      const result = await input;
      await teardown;
      expect(waited).toBe(true);
      const outcome = result !== null && 'code' in result ? result.code : result;
      expect(outcome).toBe(ending === 'timeout' ? 'action-failed' : null);
      expect(ending === 'timeout' || existsSync(finished)).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally {
      writeFileSync(release, '');
      await input;
      await control.close();
      const pid = existsSync(started) ? Number(readFileSync(started, 'utf8')) : null;
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
      await vi.waitFor(() => expect(pid === null || !alive(pid)).toBe(true));
      vi.restoreAllMocks();
      await frames.close();
      await feeds.close();
      releaseClaim(claim);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'refuses and settles hosted fold when its child identity cannot be captured',
  async () => {
    const tool = join(home, 'xcrun');
    writeFileSync(tool, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
    chmodSync(tool, 0o755);
    const env = { ...process.env, PATH: `${home}:${process.env.PATH}` };
    const frames = new FramePool(env);
    const feeds = new FeedPool('unused', env);
    vi.spyOn(frames, 'control').mockReturnValue({ send: () => {}, keys: () => true, detach: () => {} });
    vi.spyOn(frames, 'litPosture').mockReturnValue('folded');
    const claim = tryAcquireClaim({ root: join(home, 'identity-owner.claims'), mode: 'exclusive' }).acquired!;
    const control = new ControlHub({
      frameHelper: () => null,
      env,
      stimCli: 'unused',
      feeds,
      frames,
      statusFeed: { args: [], cwd: home, keep: 1, label: 'unused' },
      audit: () => {},
      lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
      idleMs: 60_000,
      renewMs: 60_000,
      leaseFor: '1m',
      foldHelper: async () => 'fixture-fold',
      foldTimeoutMs: 5000,
      conflict: () => {},
    });
    const owner = { device: { id: 'client', name: 'Client' }, send: () => {} };
    let pid: number | undefined;
    try {
      const begun = await control.beginHosted(
        owner,
        { workspace: '/client/worktree', platform: 'ios' },
        home,
        { platform: 'ios', udid: 'owned-duo', foldable: true },
        frames,
        () => true,
        claim,
      );
      if ('code' in begun) throw new Error(begun.message);
      const captureIdentity = processIdentity.captureProcessIdentity;
      vi.spyOn(processIdentity, 'captureProcessIdentity').mockImplementation((child) => {
        if (child === process.pid) return captureIdentity(child);
        pid = child;
        return { ok: false, reason: 'fixture identity unavailable' };
      });
      expect(await control.input(owner, begun.session, { input: 'posture', posture: 'unfolded' })).toMatchObject({
        code: 'action-failed',
        message: expect.stringContaining('child identity'),
      });
      expect(pid).toBeDefined();
      expect(processGroupAlive(pid!)).toBe(false);
      expect(readClaimSet(`${claim.root}.input`).unresolved).toEqual([]);
      expect(readClaimSet(`${claim.root}.input`).live).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await control.close();
      await frames.close();
      await feeds.close();
      releaseClaim(claim);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'refuses restarted native teardown while a hosted fold survives owner death',
  async () => {
    const capture = join(home, 'capture-helper');
    const fold = join(home, 'xcrun');
    const started = join(home, 'fold-pid');
    const ready = join(home, 'owner-ready');
    writeFileSync(
      capture,
      `#!${process.execPath}
const notice=Buffer.from(JSON.stringify({display:0}));const head=Buffer.alloc(5);head.writeUInt32BE(notice.length+1);head[4]=2;
const frame=Buffer.alloc(10);frame.writeUInt32BE(6);frame[4]=1;frame.writeUInt16BE(1,5);frame.writeUInt16BE(1,7);frame[9]=120;
process.stdout.write(Buffer.concat([head,notice,frame]));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);
`,
    );
    writeFileSync(
      fold,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,
    );
    chmodSync(capture, 0o755);
    chmodSync(fold, 0o755);
    writeFileSync(join(home, 'worker.mjs'), WORKER.replace("name:'stim-hosted'", "name:'stim-hosted (iPhone Duo)'"));
    const imports = (file: string) => JSON.stringify(new URL(`../src/${file}.ts`, import.meta.url).href);
    const script = join(home, 'owner.mts');
    writeFileSync(
      script,
      `import {writeFileSync} from 'node:fs';
import {DeviceHost} from ${imports('device-host')};import {HostedViews} from ${imports('hosted-view')};
import {ControlHub} from ${imports('control')};import {FramePool} from ${imports('frames')};import {FeedPool} from ${imports('feed')};
const env={...process.env,PATH:${JSON.stringify(home)}+':'+process.env.PATH};
const host=new DeviceHost({worker:${JSON.stringify(join(home, 'worker.mjs'))},env,allowed:()=>true,limits:{prepareMs:5000,stopMs:2000,killGraceMs:100}});
const answer=host.reserve('client',${JSON.stringify(request)});if('error' in answer)throw new Error(answer.error.message);
let attached;for(let i=0;i<200;i++){attached=host.attach('client',{session:answer.result.id});if(attached.result?.state==='ready')break;await new Promise(r=>setTimeout(r,20));}
const frames=new FramePool(env),feeds=new FeedPool('unused',env);
const control=new ControlHub({env,stimCli:'unused',feeds,frames,statusFeed:{args:[],cwd:${JSON.stringify(home)},keep:1,label:'unused'},audit:()=>{},lockLimits:{timeoutMs:1000,maxOutputBytes:1024},idleMs:60000,renewMs:60000,leaseFor:'1m',foldHelper:async()=> 'fixture-fold',foldTimeoutMs:60000,conflict:()=>{}});
const views=new HostedViews(host,control,env,()=>${JSON.stringify(capture)});
await new Promise(resolve=>views.subscribe('client',answer.result.id,{frame:resolve,delayed:()=>{},failed:()=>{}},{fps:5,maxEdge:480}));
const owner={device:{id:'client',name:'Client'},send:()=>{}};
const begun=await views.begin('client',answer.result.id,owner,false,()=>true);if('code' in begun)throw new Error(begun.message);
writeFileSync(${JSON.stringify(ready)},JSON.stringify(answer.result));void control.input(owner,begun.session,{input:'posture',posture:'unfolded'});
`,
    );
    const owner = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    owner.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    let foldPid: number | undefined;
    let capturePid: number | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await vi.waitFor(
        () => {
          if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(errors || 'Fixture owner exited.');
          expect(existsSync(started)).toBe(true);
        },
        { timeout: 5000 },
      );
      const session = JSON.parse(readFileSync(ready, 'utf8')) as { id: string };
      foldPid = Number(readFileSync(started, 'utf8'));
      capturePid = readClaimSet(join(deviceHostRoot(), `${session.id}.claims`)).live[0]!.child!.pid;
      const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
      owner.kill('SIGKILL');
      await exited;
      await vi.waitFor(() => expect(alive(capturePid!)).toBe(false));
      expect(alive(foldPid)).toBe(true);
      expect(host.stop('client', { session: session.id })).toHaveProperty('error.code', 'action-failed');
      expect(existsSync(join(deviceHostArea(session.id), 'home', 'stopped'))).toBe(false);
      process.kill(foldPid, 'SIGKILL');
      await vi.waitFor(() => expect(alive(foldPid!)).toBe(false));
      expect(host.stop('client', { session: session.id })).toHaveProperty('result.state', 'stopping');
      await state(session.id, 'stopped');
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      foldPid ??= existsSync(started) ? Number(readFileSync(started, 'utf8')) : undefined;
      if (foldPid && alive(foldPid)) process.kill(foldPid, 'SIGKILL');
      if (capturePid && alive(capturePid)) process.kill(capturePid, 'SIGKILL');
    }
  },
);

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
    { platform: 'web' },
    { platform: ['ios'] },
    { platform: ['android'] },
    { platform: 'android', deviceType: 'iPhone' },
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

function appOffer(session: string, attempt = 'app-first', platform = 'ios') {
  const content = Buffer.from('independent content for upload replay');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const files = [
    {
      path: platform === 'android' ? 'App.apk' : platform === 'macos' ? 'Contents/Info.plist' : 'Info.plist',
      kind: 'file',
      size: content.length,
      sha256,
    },
  ];
  if (platform === 'macos') files.push({ path: 'Contents/MacOS/Fixture', kind: 'exec', size: content.length, sha256 });
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

test.each(['ios', 'android', 'macos'])(
  'resumes %s app bytes and reconciles a lost install reply without another native launch',
  async (platform) => {
    const first = reserve({ platform });
    await state(first.id, 'ready');
    const app = appOffer(first.id, 'app-first', platform);
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
  },
);

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

test('Android reservations keep distinct ports and platform slots and reconnect without recreation', async () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsSession = validator.compile({ $ref: 'protocol#/$defs/HostedDeviceSession' });
  const androidRequest = {
    ...request,
    platform: 'android',
    attempt: 'android',
    systemImage: 'system-images;android-30;google_apis;arm64-v8a',
    deviceProfile: 'pixel_6',
  };
  expect(acceptsRequest({ id: 1, method: 'device-host.reserve', params: androidRequest })).toBe(true);
  expect(acceptsRequest({ id: 1, method: 'device-host.reserve', params: { ...androidRequest, runtime: '27.0' } })).toBe(
    false,
  );
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '3' },
    allowed: (client) => allowed.has(client),
  });
  const ios = reserve();
  const android = reserve(androidRequest);
  const second = reserve({ platform: 'android', slot: 'second', attempt: 'android-second' });
  expect(android.consolePort).toBe(5554);
  expect(second.consolePort).toBe(5556);
  expect(acceptsSession(ios)).toBe(true);
  expect(acceptsSession(android)).toBe(true);
  expect(acceptsSession(await state(ios.id, 'ready'))).toBe(true);
  expect(acceptsSession(await state(android.id, 'ready'))).toBe(true);
  await state(second.id, 'ready');
  expect(host.attach('client', { session: android.id })).toHaveProperty(
    'result.device.avdName',
    `stim-hosted-${android.id}`,
  );
  expect(reserve(androidRequest).id).toBe(android.id);
  const journal = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
  expect(() => host.viewTarget('client', android.id)).toThrow(
    'Hosted view and input currently support iOS sessions only.',
  );
  expect(
    await host.metroOpen('client', { session: android.id, gatewayPort: 12345, secret: 'a'.repeat(64) }, '127.0.0.1'),
  ).toHaveProperty('error.message', 'Hosted Metro currently supports iOS sessions only.');
  expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
  expect(host.stop('other', { session: android.id })).toHaveProperty('error.code', 'unknown-session');
  host.stop('client', { session: android.id });
  await state(android.id, 'stopped');
  expect(readClaimSet(join(deviceHostRoot(), `${android.id}.claims`)).live).toEqual([]);
  expect(host.attach('client', { session: ios.id })).toHaveProperty('result.state', 'ready');
  expect(reserve({ platform: 'android', attempt: 'replacement' }).consolePort).toBe(5554);
});

test('offers schema-compatible SDK choices without creating a journal, claim, or worker area', async () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsOffer = validator.compile({ $ref: 'protocol#/$defs/HostedDeviceOffer' });
  for (const platform of ['ios', 'android', 'macos']) {
    const params = { platform };
    expect(acceptsRequest({ id: 1, method: 'device-host.offer', params })).toBe(true);
    const answer = await host.offer('client', params);
    if ('error' in answer) throw new Error(answer.error.message);
    expect(answer.result.capacity).toEqual({ running: 0, max: 1, available: 1 });
    expect(answer.result.declined).toBeNull();
    expect(acceptsOffer(answer.result)).toBe(true);
    expect(answer.result.choice).not.toHaveProperty('udid');
    expect(acceptsOffer({ ...answer.result, platform: platform === 'ios' ? 'android' : 'ios' })).toBe(false);
  }
  expect(await host.offer('client', { platform: 'ios', deviceType: 'empty-reason' })).toHaveProperty(
    'error.code',
    'action-failed',
  );
  expect(existsSync(deviceHostRoot())).toBe(false);
  expect(existsSync(join(home, 'device-host'))).toBe(false);
  const params = { platform: 'android', runtime: '27' };
  expect(acceptsRequest({ id: 1, method: 'device-host.offer', params })).toBe(false);
  rmSync(join(home, 'probe-entered'));
  expect(await host.offer('client', params)).toHaveProperty('error.code', 'bad-request');
  expect(await host.offer('foreign', { platform: 'ios' })).toHaveProperty('error.code', 'forbidden');
  expect(existsSync(join(home, 'probe-entered'))).toBe(false);
});

test('offer capacity counts unresolved sessions and preserves SDK failures as declined choices', async () => {
  const lost = reserve({ deviceType: 'lost' });
  await state(lost.id, 'unknown');
  const before = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
  expect(await host.offer('client', { platform: 'android' })).toMatchObject({
    result: { capacity: { running: 1, max: 1, available: 0 }, declined: expect.stringContaining('unresolved') },
  });
  expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(before);
  host.stop('client', { session: lost.id });
  await state(lost.id, 'stopped');
  expect(await host.offer('client', { platform: 'ios', deviceType: 'unavailable' })).toMatchObject({
    result: { choice: null, declined: 'SDK unavailable', capacity: { running: 0, available: 1 } },
  });
  const stopped = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
  writeFileSync(join(deviceHostRoot(), 'sessions.json'), '{}');
  rmSync(join(home, 'probe-entered'));
  expect(await host.offer('client', { platform: 'ios' })).toHaveProperty('error.code', 'action-failed');
  expect(existsSync(join(home, 'probe-entered'))).toBe(false);
  writeFileSync(join(deviceHostRoot(), 'sessions.json'), stopped);
});

test.each(['revoke', 'close'])('does not publish an offer after %s during an actual pending query', async (action) => {
  const pending = host.offer('client', { platform: 'ios', deviceType: 'delayed' });
  await vi.waitFor(() => expect(existsSync(join(home, 'probe-entered'))).toBe(true));
  if (action === 'revoke') {
    allowed.delete('client');
    host.revoke();
  } else await host.close();
  expect(await pending).toHaveProperty('error.code', 'forbidden');
  expect(existsSync(deviceHostRoot())).toBe(false);
});

test('an uncapped offer still declines exhausted Android journal ports without changing the reservations', async () => {
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '0' },
    allowed: () => true,
  });
  mkdirSync(deviceHostRoot(), { recursive: true });
  const sessions = Array.from({ length: 16 }, (_, index) => ({
    ...request,
    platform: 'android',
    attempt: `occupied-${index}`,
    id: randomUUID(),
    client: 'other',
    state: 'unknown',
    device: null,
    consolePort: 5554 + index * 2,
    createdAt: new Date().toISOString(),
  }));
  const journal = JSON.stringify({ version: 1, sessions });
  writeFileSync(join(deviceHostRoot(), 'sessions.json'), journal);
  expect(await host.offer('client', { platform: 'android' })).toMatchObject({
    result: { capacity: { running: 16, max: 0, available: null }, declined: expect.stringContaining('console ports') },
  });
  expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
});

test.each(['deadline', 'revoke', 'close'])(
  'terminates synchronous SDK descendants when an offer ends by %s',
  { skip: process.platform === 'win32' },
  async (action) => {
    await host.close();
    host = new DeviceHost({
      worker: join(home, 'worker.mjs'),
      env: process.env,
      allowed: (client) => allowed.has(client),
      limits: { offerMs: action === 'deadline' ? 1000 : 5000, killGraceMs: 100 },
    });
    const pending = host.offer('client', { platform: 'ios', deviceType: 'sdk-hang' });
    await vi.waitFor(() => expect(existsSync(join(home, 'probe-descendant'))).toBe(true));
    const leader = Number(readFileSync(join(home, 'probe-entered'), 'utf8'));
    const descendant = Number(readFileSync(join(home, 'probe-descendant'), 'utf8'));
    try {
      if (action === 'revoke') {
        allowed.delete('client');
        host.revoke();
      }
      if (action === 'close') await host.close();
      expect(await pending).toHaveProperty('error.code', action === 'deadline' ? 'action-failed' : 'forbidden');
      await host.close();
      expect(processGroupAlive(leader)).toBe(false);
      expect(() => process.kill(descendant, 0)).toThrow('ESRCH');
      expect(existsSync(deviceHostRoot())).toBe(false);
    } finally {
      if (processGroupAlive(leader)) process.kill(-leader, 'SIGKILL');
    }
  },
);

test('app deliveries carry an agent grant for any driver name but only one session route and bounded secrets', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsDelivery = validator.compile({ $ref: 'protocol#/$defs/HostedAppDelivery' });
  const delivery = {
    session: '12345678-1234-1234-1234-123456789abc',
    attempt: 'app',
    bundleId: 'dev.stim.fixture',
    mode: 'release',
    state: 'installed',
    launched: true,
  };
  const grant = {
    driver: 'later-driver',
    path: '/device-host/agent/12345678-1234-1234-1234-123456789abc/',
    token: 'a'.repeat(43),
    scope: 'lease-1',
  };
  expect(acceptsDelivery({ ...delivery, agent: { driver: 'none' } })).toBe(true);
  expect(acceptsDelivery({ ...delivery, agent: grant })).toBe(true);
  for (const agent of [
    { driver: 'none', token: grant.token },
    { ...grant, driver: 'none' },
    { ...grant, path: '/device-host/agent/../12345678-1234-1234-1234-123456789abc/' },
    { ...grant, token: 'short' },
  ])
    expect(acceptsDelivery({ ...delivery, agent })).toBe(false);
});

test('macOS reservations isolate concurrent clients, validate on the wire and reuse only stopped slots', async () => {
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '2' },
    allowed: (client) => allowed.has(client),
  });
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsSession = validator.compile({ $ref: 'protocol#/$defs/HostedDeviceSession' });
  const params = { ...request, platform: 'macos' };
  for (const method of ['device-host.reserve', 'device-host.offer']) {
    const input = method === 'device-host.offer' ? { platform: 'macos' } : params;
    expect(acceptsRequest({ id: 1, method, params: input })).toBe(true);
    for (const selector of ['deviceType', 'runtime', 'systemImage', 'deviceProfile']) {
      expect(acceptsRequest({ id: 1, method, params: { ...input, [selector]: 'invalid' } })).toBe(false);
    }
  }
  const first = reserve(params);
  const secondAnswer = host.reserve('other', params);
  if ('error' in secondAnswer) throw new Error(secondAnswer.error.message);
  const second = secondAnswer.result;
  expect(first.appSlot).toBe(1);
  expect(second.appSlot).toBe(2);
  for (const session of [first, second]) {
    expect(acceptsSession(session)).toBe(true);
    expect(acceptsSession(await state(session.id, 'ready'))).toBe(true);
    expect(existsSync(join(deviceHostArea(session.id), 'home', 'created-devices.json'))).toBe(false);
  }
  expect(host.reserve('client', { ...params, attempt: 'full', slot: 'second' })).toHaveProperty(
    'error.code',
    'device-busy',
  );
  expect(() => host.viewTarget('client', first.id)).toThrow('iOS sessions only');
  expect(
    await host.metroOpen('client', { session: first.id, gatewayPort: 12345, secret: 'a'.repeat(64) }, '127.0.0.1'),
  ).toHaveProperty('error.message', 'Hosted Metro currently supports iOS sessions only.');
  host.stop('client', { session: first.id });
  await state(first.id, 'stopped');
  expect(reserve({ ...params, attempt: 'replacement' }).appSlot).toBe(1);
  expect(host.attach('other', { session: second.id })).toHaveProperty('result.state', 'ready');
});

test.each([
  { mode: 'development' },
  { mode: 'development', devClientScheme: 'fixture' },
  { devClientScheme: 'fixture' },
  { bundleId: 'com.apple.fixture' },
  { bundleId: 'a'.repeat(255) },
])('refuses macOS app offer %j before creating a receipt', async (invalid) => {
  const first = reserve({ platform: 'macos' });
  await state(first.id, 'ready');
  const app = appOffer(first.id, 'app-first', 'macos');
  expect(host.appOffer('client', { ...app.params, ...invalid })).toHaveProperty('error.code', 'action-failed');
  expect(existsSync(join(deviceHostArea(first.id), 'apps', 'app-first'))).toBe(false);
});

test('macOS offer and reserve refuse all 64 unresolved app slots without mutating the journal', async () => {
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '0' },
    allowed: () => true,
  });
  mkdirSync(deviceHostRoot(), { recursive: true });
  const sessions = Array.from({ length: 64 }, (_, index) => ({
    ...request,
    platform: 'macos',
    attempt: `occupied-${index}`,
    id: randomUUID(),
    client: 'other',
    state: 'unknown',
    device: null,
    appSlot: index + 1,
    createdAt: new Date().toISOString(),
  }));
  const journal = JSON.stringify({ version: 1, sessions });
  writeFileSync(join(deviceHostRoot(), 'sessions.json'), journal);
  expect(await host.offer('client', { platform: 'macos' })).toHaveProperty(
    'result.declined',
    expect.stringContaining('All hosted macOS app slots are reserved'),
  );
  expect(host.reserve('client', { ...request, platform: 'macos' })).toHaveProperty(
    'error.message',
    expect.stringContaining('All hosted macOS app slots are reserved'),
  );
  expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
});
