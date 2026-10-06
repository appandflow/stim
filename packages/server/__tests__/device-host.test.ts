import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
  realpathSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { workspaceName, createMetroGateway } from '@stim-cli/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deviceHostArea,
  deviceHostRoot,
  HOSTED_MACOS_APP_SLOTS,
  readHostedAppMetadata,
  readHostedSessions,
  readHostedMacosApp,
  type HostedDeviceSession,
} from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet, tryAcquireClaim, releaseClaim } from '@stim-cli/core/ownership-claim';
import * as processIdentity from '@stim-cli/core/process-identity';
import { DeviceHost } from '../src/device-host.ts';
import { AgentDriverUnavailable, HostedAgentHost, type AgentAccess, type HostedAgentApp } from '../src/agent-driver.ts';
import { protocolJsonSchema, type ServerMessage } from '../src/protocol.ts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { HostedViews } from '../src/hosted-view.ts';
import { ControlHub } from '../src/control.ts';
import { FramePool } from '../src/frames.ts';
import { FeedPool } from '../src/feed.ts';

const WORKER = `
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { workspaceName } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../core/index.ts')).href)};
import { captureProcessToken, processStartMicros } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../core/process-identity.ts')).href)};
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
} else if(input.mode === 'logs') {
  writeFileSync(join(home,'logs-entered'),String(process.pid));
  if(input.deviceType === 'logs-hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else {
    const logs=join(home,'ios-logs');mkdirSync(logs,{recursive:true});
    appendFileSync(join(logs,'device.ndjson'),JSON.stringify({ts:1,src:'device',platform:'ios',level:'error',msg:'native failure'})+'\\n');
    out({more:false});
  }
} else if(input.mode === 'install') {
  appendFileSync(join(home,'installed'),input.attempt+'\\n');
  writeFileSync(join(home,'install-metro-port'),String(input.metroPort ?? ''));
  const stored=JSON.parse(readFileSync(join(home,'hosted-device.json'),'utf8'));
  const app=JSON.parse(readFileSync(join(home,'..','apps',input.attempt,'receipt.json'),'utf8'));
  if(input.deviceType === 'install-hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else {
    if(input.platform === 'macos' && process.platform === 'darwin') {
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      child.unref();
      writeFileSync(join(home,'fake-app-pid'),String(child.pid));
      const processToken=captureProcessToken(child.pid);
      const start=processStartMicros(child.pid);
      if(!processToken || start.status !== 'running') throw new Error('Cannot identify fake macOS app');
      const runRoot=join(home,'macos-app');mkdirSync(runRoot,{recursive:true});
      const bundle=join(home,'..','apps',input.attempt,'App.app');
      const executable=join(bundle,'Contents','MacOS','Fixture');
      mkdirSync(join(bundle,'Contents','MacOS'),{recursive:true});writeFileSync(executable,'fixture');
      const bundleId=app.bundleId+'.hosted'+stored.appSlot;
      const identity={pid:child.pid,processToken,startedAtMicros:start.startedAtMicros};
      const macos={launchId:input.attempt,arguments:[],product:'Fixture',bundle,bundleId,executable,
        build:{state:'ok',startedAt:new Date().toISOString()},app:identity,supervisor:identity};
      const workspace=join(home,'workspaces',workspaceName(realpathSync(runRoot)));mkdirSync(workspace,{recursive:true});
      writeFileSync(join(workspace,'state.json'),JSON.stringify({macos}));
      writeFileSync(join(home,'hosted-macos-app.json'),JSON.stringify({bundleId}));
    }
    out({state:'installed',device:stored,launched:app.mode === 'release' ? true : 'unverified',...(input.platform === 'macos' ? {pid:4242} : {})});
  }
} else {
  writeFileSync(join(home,'stopped'),String(process.pid));
  const stored=JSON.parse(readFileSync(join(home,'hosted-device.json'),'utf8'));
  if(input.deviceType === 'delayed-stop') while(!existsSync(join(home,'release-stop'))) await new Promise(resolve=>setTimeout(resolve,20));
  if(input.deviceType === 'fail-stop') throw new Error('retirement failed');
  if(input.platform !== 'macos' && input.deviceType !== 'uncertain-stop' && input.deviceType !== 'wrong-stop') writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:[],android:[],web:[]}));
  out({state:input.deviceType === 'uncertain-stop'?'unknown':'stopped',device:input.deviceType === 'wrong-stop'?{...stored,udid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}:stored});
}
`;
const noAgents = {
  appRunning: () => Promise.resolve({ grant: { driver: 'none' } as const }),
  appStopped: () => Promise.resolve(),
  access: () => undefined,
};
const NOAGENTS = "{appRunning:async()=>({grant:{driver:'none'}}),appStopped:async()=>{},access:()=>undefined}";
type AgentCall = ['running', HostedAgentApp, string] | ['stopped', string];
let agentCalls: AgentCall[];
let agentAccess: Map<string, AgentAccess>;
let agentIssued: Map<string, AgentAccess>;
const agents = {
  appRunning: (app: HostedAgentApp) => {
    const attempt = readHostedSessions().find((record) => record.id === app.session)!.appAttempt!;
    agentCalls.push(['running', app, readHostedAppMetadata(app.session, attempt).state]);
    const access = agentAccess.get(app.session) ?? { grant: { driver: 'none' } as const };
    agentIssued.set(app.session, access);
    return Promise.resolve(access);
  },
  appStopped: (session: string) => {
    agentCalls.push(['stopped', session]);
    return Promise.resolve();
  },
  access: (session: string) => agentIssued.get(session),
};
let home: string;
let host: DeviceHost;
let allowed: Set<string>;
const request = { workspace: '/client/worktree', slot: 'default', platform: 'ios', attempt: 'first' };

beforeEach(() => {
  agentCalls = [];
  agentAccess = new Map();
  agentIssued = new Map();
  home = mkdtempSync(join(tmpdir(), 'stim-hosted-test-'));
  process.env.STIM_HOME = home;
  const worker = join(home, 'worker.mjs');
  writeFileSync(worker, WORKER);
  allowed = new Set(['client', 'other']);
  host = new DeviceHost({
    worker,
    env: { ...process.env, STIM_MAX_DEVICES: '1' },
    agents,
    allowed: (client) => allowed.has(client),
    limits: { prepareMs: 5000, stopMs: 2000, killGraceMs: 100 },
  });
});
afterEach(async () => {
  await host.close();
  const areas = join(home, 'device-host', 'sessions');
  for (const id of existsSync(areas) ? readdirSync(areas) : []) {
    const file = join(areas, id, 'home', 'fake-app-pid');
    if (existsSync(file)) {
      try {
        process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
      } catch {}
    }
  }
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
const host=new DeviceHost({worker:${JSON.stringify(join(home, 'worker.mjs'))},env,agents:${NOAGENTS},allowed:()=>true,limits:{prepareMs:5000,stopMs:2000,killGraceMs:100}});
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

test('takes no new hosted session while the server drains for an update, and still answers a retry', async () => {
  const first = reserve();
  host.drain('stim-server is updating to release 1.15.0');
  expect(reserve().id).toBe(first.id);
  expect(host.reserve('client', { ...request, attempt: 'second', workspace: '/other' })).toMatchObject({
    error: { code: 'device-busy', message: expect.stringContaining('updating to release 1.15.0') },
  });
  host.drain(null);
  await state(first.id, 'ready');
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
    agents: noAgents,
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

test.skipIf(process.platform === 'win32')(
  'keeps the server responsive and bounds cancellation of a TERM-resistant actual worker',
  async () => {
    const first = reserve({ deviceType: 'hang' });
    const file = join(deviceHostArea(first.id), 'home', 'entered');
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
    const pid = Number(readFileSync(file, 'utf8'));
    expect(host.attach('client', { session: first.id })).toHaveProperty('result.state', 'preparing');
    host.stop('client', { session: first.id });
    await state(first.id, 'stopped');
    expect(processGroupAlive(pid)).toBe(false);
  },
);

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

test.skipIf(process.platform === 'win32')(
  'terminates a TERM-resistant descendant after the worker leader exits before releasing its claim',
  async () => {
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
  },
);

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
    const host=new DeviceHost({worker:${JSON.stringify(join(home, 'worker.mjs'))},env:process.env,agents:${NOAGENTS},allowed:()=>true});
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
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsDelivery = validator.compile({ $ref: 'protocol#/$defs/HostedAppDelivery' });
    const first = reserve({ platform });
    await state(first.id, 'ready');
    const app = appOffer(first.id, 'app-first', platform);
    const { content, sha256 } = app;
    const params = {
      ...app.params,
      ...(platform === 'macos' ? { arguments: ['-autopilot.enabled', 'true', ''] } : {}),
    };
    expect(host.appOffer('other', params)).toHaveProperty('error');
    expect(host.appOffer('client', params)).toHaveProperty('result.missing.0.offset', 0);
    const receiving = host.appAttach('client', params);
    expect(receiving).toHaveProperty('result.state', 'receiving');
    expect(receiving).not.toHaveProperty('result.agent');
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
    for (const args of platform === 'macos'
      ? [undefined, ['-autopilot.enabled', 'false'], ['true', '-autopilot.enabled', '']]
      : [])
      expect(host.appOffer('client', { ...params, arguments: args })).toHaveProperty(
        'error.message',
        'This app attempt already describes different content.',
      );
    const installing = host.appLaunch('client', params);
    expect(installing).toHaveProperty('result.state', 'installing');
    expect(installing).not.toHaveProperty('result.agent');
    expect(host.appAttach('client', params)).not.toHaveProperty('result.agent');
    await vi.waitFor(() => expect(host.appAttach('client', params)).toHaveProperty('result.state', 'installed'));
    const installed = host.appAttach('client', params);
    for (const answer of [installed, host.appLaunch('client', params)]) {
      if ('error' in answer) throw new Error(answer.error.message);
      expect(answer.result.launched).toBe(true);
      expect(acceptsDelivery(answer.result)).toBe(true);
      expect(answer.result.arguments).toEqual(params.arguments);
      expect(answer.result.agent).toEqual(platform === 'macos' ? { driver: 'none' } : undefined);
      expect('agent' in answer.result).toBe(platform === 'macos');
    }
    const receipt = join(deviceHostArea(first.id), 'apps', params.attempt, 'receipt.json');
    const received = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(received).not.toHaveProperty('agent');
    expect(received.arguments).toEqual(params.arguments);
    expect(readFileSync(join(deviceHostArea(first.id), 'home', 'installed'), 'utf8')).toBe('app-first\n');
    expect(host.attach('client', { session: first.id })).toHaveProperty('result.appAttempt', params.attempt);
    if (platform === 'macos') {
      host.stop('client', { session: first.id });
      await state(first.id, 'stopped');
      rmSync(join(deviceHostArea(first.id), 'blobs'), { recursive: true });
    }
    const attached = host.appAttach('client', params);
    expect(attached).toHaveProperty('result.state', 'installed');
    expect(attached).not.toHaveProperty('result.agent');
    const stored = JSON.parse(readFileSync(receipt, 'utf8'));
    writeFileSync(receipt, JSON.stringify({ ...stored, state: 'unknown', launched: null }));
    const unknown = host.appAttach('client', params);
    expect(unknown).toHaveProperty('result.state', 'unknown');
    expect(unknown).not.toHaveProperty('result.agent');
  },
);

async function installApp(platform: string, access?: AgentAccess) {
  const first = reserve({ platform });
  if (access) agentAccess.set(first.id, access);
  await state(first.id, 'ready');
  const app = appOffer(first.id, 'app-first', platform);
  host.appOffer('client', app.params);
  await uploadManifest(app);
  await host.appChunk('client', {
    session: first.id,
    attempt: app.params.attempt,
    sha256: app.sha256,
    offset: 0,
    data: app.content.toString('base64'),
  });
  host.appLaunch('client', app.params);
  await vi.waitFor(() => expect(host.appAttach('client', app.params)).toHaveProperty('result.state', 'installed'));
  return { id: first.id, params: app.params };
}

describe('hosted agent control', () => {
  const grant = {
    driver: 'agent-device' as const,
    path: `/device-host/agent/${randomUUID()}/`,
    token: 'a'.repeat(43),
    scope: 'lease-1',
    lease: { tenant: 'stim.s', runId: 'run-1', clientId: 'agent', deviceKey: 'dev.fixture.app.hosted1@4242' },
  };

  test('starts macOS agent control for the installed process before the receipt reads installed and hands out its grant', async () => {
    const { id, params } = await installApp('macos', { grant });
    expect(agentCalls).toEqual([
      [
        'running',
        {
          client: 'client',
          session: id,
          bundleId: 'dev.stim.fixture.hosted1',
          pid: 4242,
        },
        'installing',
      ],
    ]);
    expect(host.appAttach('client', params)).toHaveProperty('result.agent', grant);
    const receipt = readFileSync(join(deviceHostArea(id), 'apps', params.attempt, 'receipt.json'), 'utf8');
    const journal = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    expect(receipt).not.toContain(grant.token);
    expect(journal).not.toContain(grant.token);
  });

  test('reports the notice that explains a missing driver without storing it', async () => {
    const { id, params } = await installApp('macos', {
      grant: { driver: 'none' },
      notice: 'No lease.',
    });
    const attached = host.appAttach('client', params);
    expect(attached).toHaveProperty('result.agent', { driver: 'none' });
    expect(attached).toHaveProperty('result.notice', 'No lease.');
    expect(readFileSync(join(deviceHostArea(id), 'apps', params.attempt, 'receipt.json'), 'utf8')).not.toContain(
      'No lease.',
    );
  });

  test.each(['ios', 'android'])('never starts agent control for %s apps', async (platform) => {
    const { params } = await installApp(platform);
    expect(host.appAttach('client', params)).not.toHaveProperty('result.agent');
    expect(agentCalls.filter(([kind]) => kind === 'running')).toEqual([]);
  });

  test.each(['stop', 'revoke', 'close'])('ends agent control when the session ends by %s', async (how) => {
    const { id } = await installApp('macos', { grant });
    agentCalls.length = 0;
    if (how === 'stop') host.stop('client', { session: id });
    else if (how === 'revoke') {
      allowed.delete('client');
      host.revoke();
    } else await host.close();
    expect(agentCalls).toContainEqual(['stopped', id]);
    await state(id, 'stopped');
  });

  test('hands out no driver and the host notice while the driver cannot lease one app', async () => {
    const real = new HostedAgentHost({
      resolve: () => ({
        name: 'agent-device',
        start: () => Promise.reject(new AgentDriverUnavailable('agent-device cannot lease one macOS app yet.')),
        stop: () => Promise.resolve(),
        issue: () => Promise.reject(new Error('unreachable')),
        revoke: () => Promise.resolve(),
        forward: () => undefined,
        onExit: () => undefined,
      }),
      nodeOf: () => null,
    });
    host = new DeviceHost({
      worker: join(home, 'worker.mjs'),
      env: { ...process.env, STIM_MAX_DEVICES: '1' },
      agents: real,
      allowed: (client) => allowed.has(client),
      limits: { prepareMs: 5000, stopMs: 2000, killGraceMs: 100 },
    });
    const { params } = await installApp('macos');
    const attached = host.appAttach('client', params);
    expect(attached).toHaveProperty('result.agent', { driver: 'none' });
    expect(attached).toHaveProperty('result.notice', 'agent-device cannot lease one macOS app yet.');
  });
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
  { skip: process.platform === 'win32' },
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
    agents: noAgents,
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
    'Hosted view and input support iOS and macOS sessions only.',
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
    agents: noAgents,
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
      agents: noAgents,
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
    lease: { tenant: 'stim.s', runId: 'run-1', clientId: 'agent', deviceKey: 'dev.fixture.app.hosted1@4242' },
  };
  expect(acceptsDelivery({ ...delivery, agent: { driver: 'none' } })).toBe(true);
  expect(acceptsDelivery({ ...delivery, agent: grant })).toBe(true);
  for (const agent of [
    { driver: 'none', token: grant.token },
    { ...grant, driver: 'none' },
    { ...grant, path: '/device-host/agent/../12345678-1234-1234-1234-123456789abc/' },
    { ...grant, token: 'short' },
    { ...grant, lease: { ...grant.lease, deviceKey: 'dev.fixture.app.hosted1' } },
  ])
    expect(acceptsDelivery({ ...delivery, agent })).toBe(false);
});

test('macOS reservations isolate concurrent clients, validate on the wire and reuse only stopped slots', async () => {
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '2' },
    agents: noAgents,
    allowed: (client) => allowed.has(client),
  });
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const acceptsSession = validator.compile({ $ref: 'protocol#/$defs/HostedDeviceSession' });
  const offer = appOffer('12345678-1234-1234-1234-123456789abc', 'app', 'macos').params;
  expect(
    acceptsRequest({ id: 1, method: 'device-host.app.offer', params: { ...offer, arguments: ['flag', ''] } }),
  ).toBe(true);
  for (const args of ['flag', [false], Array(33).fill(''), ['a'.repeat(1025)], ['line\nvalue'], ['nul\0value']])
    expect(acceptsRequest({ id: 1, method: 'device-host.app.offer', params: { ...offer, arguments: args } })).toBe(
      false,
    );
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
  expect(() => host.viewTarget('client', first.id)).toThrow('not running');
  expect(
    await host.metroOpen('client', { session: first.id, gatewayPort: 12345, secret: 'a'.repeat(64) }, '127.0.0.1'),
  ).toHaveProperty('error.message', 'Hosted Metro currently supports iOS sessions only.');
  host.stop('client', { session: first.id });
  await state(first.id, 'stopped');
  expect(reserve({ ...params, attempt: 'replacement' }).appSlot).toBe(1);
  expect(host.attach('other', { session: second.id })).toHaveProperty('result.state', 'ready');
});

test.each([
  [{ mode: 'development' }, 'action-failed'],
  [{ mode: 'development', devClientScheme: 'fixture' }, 'action-failed'],
  [{ devClientScheme: 'fixture' }, 'bad-request'],
  [{ bundleId: 'com.apple.fixture' }, 'action-failed'],
  [{ bundleId: 'a'.repeat(250 - '.hosted1'.length) }, 'action-failed'],
  [{ bundleId: 'a'.repeat(249 - '.hosted1'.length) }, null],
])('validates macOS app offer %j with outcome %s before creating a receipt', async (invalid, code) => {
  const first = reserve({ platform: 'macos' });
  await state(first.id, 'ready');
  const app = appOffer(first.id, 'app-first', 'macos');
  expect(host.appOffer('client', { ...app.params, ...invalid })).toHaveProperty(
    code === null ? 'result.delivery.state' : 'error.code',
    code ?? 'receiving',
  );
  expect(existsSync(join(deviceHostArea(first.id), 'apps', 'app-first'))).toBe(code === null);
});

test.each(['ios', 'android'])('refuses app arguments in a %s session before creating a receipt', async (platform) => {
  const first = reserve({ platform });
  await state(first.id, 'ready');
  const app = appOffer(first.id, 'app-first', platform);
  expect(host.appOffer('client', { ...app.params, arguments: ['-autopilot.enabled'] })).toHaveProperty(
    'error.message',
    'App arguments are supported only for hosted macOS sessions.',
  );
  expect(existsSync(join(deviceHostArea(first.id), 'apps', 'app-first'))).toBe(false);
  expect(host.appOffer('client', { ...app.params, arguments: [] })).toHaveProperty(
    'result.delivery.state',
    'receiving',
  );
  expect(host.appOffer('client', app.params)).toHaveProperty('result.delivery.state', 'receiving');
});

test.each([
  ['ios', 'macos'],
  ['android', 'macos'],
  ['macos', 'ios'],
  ['macos', 'android'],
])('refuses a %s app manifest in a %s session without starting native installation', async (appPlatform, platform) => {
  const first = reserve({ platform });
  await state(first.id, 'ready');
  const app = appOffer(first.id, 'wrong-platform', appPlatform);
  const { params, content, sha256 } = app;
  expect(host.appOffer('client', params)).toHaveProperty('result.delivery.state', 'receiving');
  await uploadManifest(app);
  expect(
    await host.appChunk('client', { ...params, sha256, offset: 0, data: content.toString('base64') }),
  ).toHaveProperty('result.offset', content.length);
  expect(host.appLaunch('client', params)).toMatchObject({
    error: { code: 'action-failed', message: expect.stringContaining('Contents/Info.plist') },
  });
  expect(host.attach('client', { session: first.id })).toHaveProperty('result.state', 'ready');
  expect(host.appAttach('client', params)).toHaveProperty('result.state', 'receiving');
  expect(existsSync(join(deviceHostArea(first.id), 'home', 'installed'))).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'returns the hosted macOS app logs to its own client only, in pages, also after the session stopped',
  async () => {
    await host.close();
    host = new DeviceHost({
      worker: join(home, 'worker.mjs'),
      env: { ...process.env, STIM_MAX_DEVICES: '2' },
      agents: noAgents,
      allowed: (client) => allowed.has(client),
    });
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsRequest = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
    const macos = reserve({ platform: 'macos' });
    await state(macos.id, 'ready');
    const logs = join(
      deviceHostArea(macos.id),
      'home',
      'workspaces',
      workspaceName(realpathSync(mkdirSync(join(deviceHostArea(macos.id), 'home', 'macos-app'), { recursive: true })!)),
      'logs',
    );
    const query = (params: object, client = 'client') => host.logsQuery(client, { session: macos.id, ...params });
    expect(await query({})).toEqual({ result: { records: [], cursor: {}, more: false } });
    mkdirSync(logs, { recursive: true });
    const line = (n: number) =>
      `${JSON.stringify({ ts: n, src: 'client', platform: 'macos', level: 'info', msg: `line ${n}` })}\n`;
    writeFileSync(join(logs, 'macos.ndjson'), line(1) + line(2) + '{"ts":3,"msg":"half');
    const first = await query({});
    if ('error' in first) throw new Error(first.error.message);
    expect(first.result.records.map((record) => record.msg)).toEqual(['line 1', 'line 2']);
    expect(first.result.more).toBe(false);
    appendFileSync(join(logs, 'macos.ndjson'), ` written"}\n${line(4)}`);
    const second = await query({ cursor: first.result.cursor });
    if ('error' in second) throw new Error(second.error.message);
    expect(second.result.records.map((record) => record.msg)).toEqual(['half written', 'line 4']);
    renameSync(join(logs, 'macos.ndjson'), join(logs, 'macos.ndjson.1'));
    appendFileSync(join(logs, 'macos.ndjson.1'), line(5));
    writeFileSync(join(logs, 'macos.ndjson'), line(6));
    const third = await query({ cursor: second.result.cursor });
    if ('error' in third) throw new Error(third.error.message);
    expect(third.result.records.map((record) => record.msg)).toEqual(['line 5', 'line 6']);
    expect(await query({}, 'other')).toHaveProperty('error.code', 'unknown-session');
    expect(await query({ cursor: { '../escape.ndjson': 0 } })).toHaveProperty('error.code', 'bad-request');
    expect(await query({ cursor: { 'macos.ndjson': -1 } })).toHaveProperty('error.code', 'bad-request');
    expect(acceptsRequest({ id: 1, method: 'device-host.logs.query', params: { session: macos.id } })).toBe(true);
    expect(
      acceptsRequest({ id: 1, method: 'device-host.logs.query', params: { session: macos.id, cursor: { a: 1.5 } } }),
    ).toBe(false);
    host.stop('client', { session: macos.id });
    await state(macos.id, 'stopped');
    expect(await query({})).toHaveProperty('result.records.length', 1);
    allowed.delete('client');
    expect(await query({})).toHaveProperty('error.code', 'forbidden');
    allowed.add('client');
    await host.close();
  },
);

test('macOS offer and reserve refuse all 64 unresolved app slots without mutating the journal', async () => {
  await host.close();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: { ...process.env, STIM_MAX_DEVICES: '0' },
    agents: noAgents,
    allowed: () => true,
  });
  mkdirSync(deviceHostRoot(), { recursive: true });
  const sessions = Array.from({ length: HOSTED_MACOS_APP_SLOTS }, (_, index) => ({
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

describe.skipIf(process.platform !== 'darwin')('hosted macOS view and input', () => {
  let frames: FramePool;
  let feeds: FeedPool;
  let control: ControlHub;
  let views: HostedViews;
  let helper: string;
  const sent: ServerMessage[] = [];
  const owner = { device: { id: 'client', name: 'Client' }, send: (message: ServerMessage) => sent.push(message) };

  beforeEach(() => {
    sent.length = 0;
    helper = join(home, 'macos-capture');
    writeFileSync(
      helper,
      `#!${process.execPath}
const {writeFileSync,appendFileSync}=require('node:fs');
writeFileSync(process.env.STIM_HOME+'/capture-argv',JSON.stringify(process.argv));
const app=JSON.parse(process.argv[3]);
const header=Buffer.alloc(9);header.writeUInt32BE(6);header[4]=1;header.writeUInt16BE(1,5);header.writeUInt16BE(1,7);
process.stdout.write(Buffer.concat([header,Buffer.from('x')]));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>appendFileSync(process.env.STIM_HOME+'/capture-input',line+'\\n'));
process.stdin.on('end',()=>process.exit(0));
setInterval(()=>{try{process.kill(app.app.pid,0);}catch{process.stderr.write('The owned macOS app exited.');process.exit(1);}},20);
`,
    );
    chmodSync(helper, 0o755);
    frames = new FramePool(process.env);
    feeds = new FeedPool(join(home, 'unused-cli.mjs'), process.env);
    control = new ControlHub({
      frameHelper: () => null,
      env: process.env,
      stimCli: join(home, 'unused-cli.mjs'),
      feeds,
      frames,
      statusFeed: { args: [], cwd: home, keep: 1, label: 'unused hosted status' },
      audit: () => {},
      lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
      idleMs: 60_000,
      renewMs: 60_000,
      leaseFor: '1m',
      foldHelper: async () => helper,
      foldTimeoutMs: 1000,
      conflict: () => {},
    });
    views = new HostedViews(host, control, process.env, () => helper);
  });
  afterEach(async () => {
    await host.close();
    await control.close();
    await frames.close();
    await feeds.close();
  });

  async function launch() {
    const first = reserve({ platform: 'macos' });
    await state(first.id, 'ready');
    const app = appOffer(first.id, 'app-first', 'macos');
    expect(host.appOffer('client', app.params)).toHaveProperty('result');
    await uploadManifest(app);
    await host.appChunk('client', {
      ...app.params,
      sha256: app.sha256,
      offset: 0,
      data: app.content.toString('base64'),
    });
    expect(host.appLaunch('client', app.params)).toHaveProperty('result.state', 'installing');
    await vi.waitFor(() => expect(host.appAttach('client', app.params)).toHaveProperty('result.state', 'installed'));
    const workerHome = join(deviceHostArea(first.id), 'home');
    const file = join(
      workerHome,
      'workspaces',
      workspaceName(realpathSync(join(workerHome, 'macos-app'))),
      'state.json',
    );
    return { first, workerHome, file, app: readHostedMacosApp(workerHome)! };
  }

  test('refuses viewing before app launch and a different hosting client', async () => {
    const first = reserve({ platform: 'macos' });
    await state(first.id, 'ready');
    const listener = { frame: () => {}, delayed: () => {}, failed: () => {} };
    expect(() => views.subscribe('client', first.id, listener, { fps: 5, maxEdge: 480 })).toThrow('not running');
    expect(() => views.subscribe('other', first.id, listener, { fps: 5, maxEdge: 480 })).toThrow(
      'Only a ready session',
    );
    expect(() => views.begin('other', first.id, owner, false, () => true)).toThrow('Only a ready session');
  });

  test('keeps the running app viewable while a replacement attempt is offered', async () => {
    const { first } = await launch();
    const replacement = appOffer(first.id, 'app-second', 'macos');
    expect(host.appOffer('client', replacement.params)).toHaveProperty('result');
    expect(views.target('client', first.id).device.platform).toBe('macos');
  });

  test('captures only the running hosted app and sends scroll and key input, then closes capture and control after exit', async () => {
    const { first, workerHome, app } = await launch();
    const failed: string[] = [];
    const captured: unknown[] = [];
    views.subscribe(
      'client',
      first.id,
      { frame: (frame) => captured.push(frame), delayed: () => {}, failed: (message) => failed.push(message) },
      { fps: 5, maxEdge: 480 },
    );
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    const argv = JSON.parse(readFileSync(join(workerHome, 'capture-argv'), 'utf8'));
    expect(argv[2]).toBe('macos');
    expect(JSON.parse(argv[3])).toMatchObject({ bundleId: 'dev.stim.fixture.hosted1', app: { pid: app.app!.pid } });
    const claims = join(deviceHostRoot(), `${first.id}.claims`);
    expect(readClaimSet(claims).live[0]!.child).not.toBeNull();
    const begun = await views.begin('client', first.id, owner, false, () => true);
    if ('code' in begun) throw new Error(begun.message);
    expect(begun.lease).toBeNull();
    const scroll = { input: 'scroll' as const, x: 0.25, y: 0.75, deltaX: -5, deltaY: 10 };
    const key = { input: 'key' as const, key: 'a' as const, modifiers: ['command' as const] };
    expect(await control.input(owner, begun.session, scroll)).toBeNull();
    expect(await control.input(owner, begun.session, key)).toBeNull();
    await vi.waitFor(() => {
      const input = readFileSync(join(workerHome, 'capture-input'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(input).toEqual(expect.arrayContaining([expect.objectContaining(scroll), expect.objectContaining(key)]));
    });
    expect(() => views.target('other', first.id)).toThrow('Only a ready session');
    process.kill(app.app!.pid, 'SIGKILL');
    await vi.waitFor(() => expect(failed).toEqual([expect.stringContaining('The owned macOS app exited.')]));
    await vi.waitFor(() => expect(readClaimSet(claims).live[0]!.child).toBeNull());
    expect(await control.input(owner, begun.session, key)).toHaveProperty('code', 'unknown-session');
    expect(() => views.target('client', first.id)).toThrow('not running');
    expect(sent).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'control-ended', session: begun.session })]),
    );
  });

  test.each(['bundleId', 'stored bundleId', 'bundle', 'executable', 'symlinked executable', 'appSlot', 'supervisor'])(
    'refuses capture when %s does not belong to the running hosted session',
    async (field) => {
      const { first, workerHome, file, app } = await launch();
      const changed = { ...app };
      const outside = join(home, 'outside');
      writeFileSync(outside, 'outside');
      if (field === 'bundleId') changed.bundleId = 'dev.other.hosted1';
      if (field === 'stored bundleId')
        writeFileSync(join(workerHome, 'hosted-macos-app.json'), JSON.stringify({ bundleId: 'dev.other.hosted1' }));
      if (field === 'bundle') changed.bundle = home;
      if (field === 'executable') changed.executable = outside;
      if (field === 'symlinked executable') {
        rmSync(app.executable);
        symlinkSync(outside, app.executable);
      }
      if (field === 'appSlot') {
        const device = JSON.parse(readFileSync(join(workerHome, 'hosted-device.json'), 'utf8'));
        writeFileSync(join(workerHome, 'hosted-device.json'), JSON.stringify({ ...device, appSlot: 2 }));
      }
      if (field === 'supervisor') delete changed.supervisor;
      writeFileSync(file, JSON.stringify({ macos: changed }));
      expect(() => views.target('client', first.id)).toThrow(
        field === 'supervisor'
          ? 'The hosted macOS app is not running.'
          : field === 'appSlot'
            ? 'The device record no longer matches this session.'
            : 'The macOS app does not belong to this hosted session.',
      );
      expect(existsSync(join(workerHome, 'capture-argv'))).toBe(false);
    },
  );

  test.each(['launchId', 'startedAtMicros', 'pid'])(
    'refuses an existing view and input when the hosted app %s changes',
    async (field) => {
      const { first, file, app } = await launch();
      const begun = await views.begin('client', first.id, owner, false, () => true);
      if ('code' in begun) throw new Error(begun.message);
      const changed = { ...app, app: { ...app.app! } };
      if (field === 'launchId') changed.launchId = 'replacement';
      if (field === 'startedAtMicros') changed.app.startedAtMicros += 1;
      if (field === 'pid') {
        const processToken = processIdentity.captureProcessToken(process.pid)!;
        const start = processIdentity.processStartMicros(process.pid);
        if (start.status !== 'running') throw new Error('Cannot identify test process');
        changed.app = { pid: process.pid, processToken, startedAtMicros: start.startedAtMicros };
      }
      writeFileSync(file, JSON.stringify({ macos: changed }));
      expect(() => views.target('client', first.id)).toThrow('The hosted device changed');
      expect(await control.input(owner, begun.session, { input: 'key', key: 'return', modifiers: [] })).toHaveProperty(
        'code',
        'forbidden',
      );
    },
  );

  test('an Accessibility refusal ends hosted control while the app window remains viewable', async () => {
    const { first } = await launch();
    const refusal = 'Control needs Accessibility permission for the capture host.';
    writeFileSync(
      helper,
      `#!${process.execPath}
const message=(kind,body)=>{const header=Buffer.alloc(5);header.writeUInt32BE(body.length+1);header[4]=kind;process.stdout.write(Buffer.concat([header,body]));};
message(1,Buffer.from([0,1,0,1,120]));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const command=JSON.parse(line);
  if(command.input)message(2,Buffer.from(JSON.stringify({inputError:${JSON.stringify(refusal)},controlSession:command.controlSession})));
});
process.stdin.on('end',()=>process.exit(0));
`,
    );
    const failed: string[] = [];
    const captured: unknown[] = [];
    views.subscribe(
      'client',
      first.id,
      { frame: (frame) => captured.push(frame), delayed: () => {}, failed: (message) => failed.push(message) },
      { fps: 5, maxEdge: 480 },
    );
    const begun = await views.begin('client', first.id, owner, false, () => true);
    if ('code' in begun) throw new Error(begun.message);
    expect(await control.input(owner, begun.session, { input: 'key', key: 'return', modifiers: [] })).toBeNull();
    await vi.waitFor(() =>
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'control-ended', session: begun.session, message: refusal }),
        ]),
      ),
    );
    expect(await control.input(owner, begun.session, { input: 'key', key: 'return', modifiers: [] })).toHaveProperty(
      'code',
      'unknown-session',
    );
    expect(captured).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(views.target('client', first.id).device.platform).toBe('macos');
    expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live[0]!.child).not.toBeNull();
  });

  test('ends the hosted subscription and control with the helper refusal', async () => {
    const refusal = 'Screen Recording access is unavailable for stim-frames.';
    const { first } = await launch();
    writeFileSync(helper, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(refusal)});process.exit(1);\n`);
    const failed: string[] = [];
    views.subscribe(
      'client',
      first.id,
      { frame: () => {}, delayed: () => {}, failed: (message) => failed.push(message) },
      { fps: 5, maxEdge: 480 },
    );
    const begun = await views.begin('client', first.id, owner, false, () => true);
    if ('code' in begun) throw new Error(begun.message);
    await vi.waitFor(() => expect(failed).toEqual([expect.stringContaining(refusal)]));
    expect(await control.input(owner, begun.session, { input: 'key', key: 'return', modifiers: [] })).toHaveProperty(
      'code',
      'unknown-session',
    );
    await vi.waitFor(() =>
      expect(readClaimSet(join(deviceHostRoot(), `${first.id}.claims`)).live[0]!.child).toBeNull(),
    );
  });
});

test('hosted window, scroll and key requests validate bounded ids, coordinates, deltas, keys and unique modifiers', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const accepts = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const scroll = { session: 'c1', x: 0, y: 1, deltaX: -1000, deltaY: 1000 };
  const key = { session: 'c1', key: 'a', modifiers: ['command', 'shift'] };
  for (const [method, params, invalid] of [
    ...['input.window', 'device-host.input.window'].flatMap((inputMethod) =>
      [null, 0, 0xffffffff].map(
        (window) =>
          [
            inputMethod,
            { session: 'c1', window },
            [
              { session: 'c1', window: -1 },
              { session: 'c1', window: 0x100000000 },
              { session: 'c1', window: 1.5 },
              { session: 'c1', window: '7' },
              { session: 'c1' },
              { window },
            ],
          ] as const,
      ),
    ),
    [
      'device-host.input.scroll',
      scroll,
      [
        { ...scroll, x: -0.1 },
        { ...scroll, deltaY: 1001 },
        { ...scroll, deltaX: undefined },
        { ...scroll, session: undefined },
      ],
    ],
    [
      'device-host.input.key',
      key,
      [
        { ...key, key: 'invalid' },
        { ...key, modifiers: ['command', 'command'] },
        { ...key, modifiers: ['invalid'] },
        { ...key, session: undefined },
      ],
    ],
  ] as const) {
    expect(accepts({ id: 1, method, params })).toBe(true);
    for (const bad of invalid) expect(accepts({ id: 1, method, params: bad })).toBe(false);
  }
});

test('the congestion notice request names one subscription', () => {
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(protocolJsonSchema(), 'protocol');
  const accepts = validator.compile({ $ref: 'protocol#/$defs/ClientRequest' });
  const method = 'device-host.frames.congested';
  expect(accepts({ id: 1, method, params: { subscription: 's1' } })).toBe(true);
  for (const params of [{}, { subscription: 1 }, { subscription: 's1', bitrate: 1 }])
    expect(accepts({ id: 1, method, params })).toBe(false);
});

test('iOS logs are isolated to their client, persist after stop and refuse a simultaneous native operation', async () => {
  const session = reserve();
  await state(session.id, 'ready');
  const app = appOffer(session.id);
  expect(host.appOffer('client', app.params)).toHaveProperty('result');
  await uploadManifest(app);
  await host.appChunk('client', { ...app.params, sha256: app.sha256, offset: 0, data: app.content.toString('base64') });
  expect(host.appLaunch('client', app.params)).toHaveProperty('result.state', 'installing');
  await vi.waitFor(() => expect(host.appAttach('client', app.params)).toHaveProperty('result.state', 'installed'));
  const query = { session: session.id };
  expect(await host.logsQuery('other', query)).toHaveProperty('error.code', 'unknown-session');
  const pending = host.logsQuery('client', query);
  expect(host.appOffer('client', { ...app.params, attempt: 'new-app' })).toHaveProperty(
    'error.message',
    expect.stringContaining('native operation'),
  );
  const first = await pending;
  if ('error' in first) throw new Error(first.error.message);
  expect(first.result.records).toMatchObject([{ src: 'device', level: 'error', msg: 'native failure' }]);
  host.stop('client', query);
  await state(session.id, 'stopped');
  expect(await host.logsQuery('client', { ...query, cursor: first.result.cursor })).toHaveProperty(
    'result.records',
    [],
  );
  expect(await host.logsQuery('client', query)).toHaveProperty('result.records.0.msg', 'native failure');
});

test.each(['stop', 'close', 'revoke'])(
  'a bounded iOS log worker is cancelled and settled before %s deletes its device',
  async (ending) => {
    const session = reserve({ deviceType: 'logs-hang' });
    await state(session.id, 'ready');
    const app = appOffer(session.id);
    host.appOffer('client', app.params);
    await uploadManifest(app);
    await host.appChunk('client', {
      ...app.params,
      sha256: app.sha256,
      offset: 0,
      data: app.content.toString('base64'),
    });
    host.appLaunch('client', app.params);
    await vi.waitFor(() => expect(host.appAttach('client', app.params)).toHaveProperty('result.state', 'installed'));
    const pending = host.logsQuery('client', { session: session.id });
    const workerHome = join(deviceHostArea(session.id), 'home');
    await vi.waitFor(() => expect(existsSync(join(workerHome, 'logs-entered'))).toBe(true));
    const pid = Number(readFileSync(join(workerHome, 'logs-entered'), 'utf8'));
    if (ending === 'close') await host.close();
    else if (ending === 'revoke') {
      allowed.delete('client');
      host.revoke();
    } else host.stop('client', { session: session.id });
    expect(await pending).toHaveProperty('error');
    await state(session.id, 'stopped');
    expect(processGroupAlive(pid)).toBe(false);
    expect(existsSync(join(workerHome, 'stopped'))).toBe(true);
  },
);

test('an iOS session takes verified files from a retained build instead of requiring an upload', async () => {
  await host.close();
  const bundle = join(home, 'Built.app');
  mkdirSync(bundle);
  const release = vi.fn<() => void>();
  host = new DeviceHost({
    worker: join(home, 'worker.mjs'),
    env: process.env,
    agents: noAgents,
    allowed: (client) => allowed.has(client),
    builtBundle: () => ({ bundle, release }),
  });
  const session = reserve();
  await state(session.id, 'ready');
  const app = appOffer(session.id);
  writeFileSync(join(bundle, 'Info.plist'), app.content);
  host.appOffer('client', app.params);
  await uploadManifest(app);
  expect(
    await host.appHandoff('client', { ...app.params, build: { handoff: 'a'.repeat(64), sha256: 'b'.repeat(64) } }),
  ).toHaveProperty('result', { files: 1, bytes: app.content.length });
  expect(release).toHaveBeenCalledOnce();
  expect(host.appOffer('client', app.params)).toHaveProperty('result.missing', []);
});

function expectRetired(id: string): void {
  expect(JSON.parse(readFileSync(join(deviceHostArea(id), 'home', 'created-devices.json'), 'utf8'))).toEqual({
    version: 1,
    ios: [],
    android: [],
    web: [],
  });
}

function seedHosted(
  extra: Partial<HostedDeviceSession> = {},
  ledger: 'listed' | 'empty' | 'missing' = 'listed',
): HostedDeviceSession {
  const records = readHostedSessions();
  const id = randomUUID();
  const platform = extra.platform ?? 'ios';
  const device =
    platform === 'android'
      ? {
          avdName: `stim-hosted-${id}`,
          serial: 'emulator-5554',
          consolePort: 5554,
          systemImage: 'system-images;android-30;google_apis;arm64-v8a',
          deviceProfile: 'pixel_6',
          architecture: 'arm64-v8a' as const,
        }
      : platform === 'macos'
        ? { appSlot: 1, architecture: 'arm64' as const, macosVersion: '27.0' }
        : {
            udid: '12345678-1234-1234-1234-123456789abc',
            name: 'stim-hosted',
            deviceTypeId: 'iphone',
            runtimeId: 'ios',
            deviceType: 'iPhone',
            runtime: '27.1',
            architecture: 'arm64' as const,
          };
  const record: HostedDeviceSession = {
    ...request,
    platform,
    id,
    client: 'client',
    state: 'stopped',
    device,
    createdAt: new Date().toISOString(),
    ...(platform === 'android' ? { consolePort: 5554 } : platform === 'macos' ? { appSlot: 1 } : {}),
    ...extra,
  };
  mkdirSync(deviceHostRoot(), { recursive: true });
  writeFileSync(
    join(deviceHostRoot(), 'sessions.json'),
    JSON.stringify({ version: 1, sessions: [...records, record] }),
  );
  const area = join(deviceHostArea(id), 'home');
  mkdirSync(area, { recursive: true });
  writeFileSync(join(area, 'hosted-device.json'), JSON.stringify(device));
  if (ledger !== 'missing')
    writeFileSync(
      join(area, 'created-devices.json'),
      JSON.stringify({
        version: 1,
        ios: ledger === 'listed' && 'udid' in device ? [device.udid] : [],
        android: ledger === 'listed' && 'avdName' in device ? [device.avdName] : [],
        web: [],
      }),
    );
  return record;
}

test.each(['ios', 'android'] as const)(
  'reconciliation retires a stopped %s device in its private home without approval or journal changes',
  async (platform) => {
    const record = seedHosted({ platform });
    const journal = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    allowed.clear();
    await host.reconcileStopped();
    expectRetired(record.id);
    expect(existsSync(join(deviceHostArea(record.id), 'home', 'stopped'))).toBe(true);
    expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
    expect(readClaimSet(join(deviceHostRoot(), `${record.id}.claims`)).live).toEqual([]);
  },
);

test('reconciliation never spawns workers for empty, missing, macOS or non-stopped sessions', async () => {
  const records = [
    seedHosted({}, 'empty'),
    seedHosted({}, 'missing'),
    seedHosted({ platform: 'macos' }),
    ...(['unknown', 'ready', 'preparing', 'stopping'] as const).map((phase) => seedHosted({ state: phase })),
  ];
  const journal = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
  await host.reconcileStopped();
  for (const record of records) expect(existsSync(join(deviceHostArea(record.id), 'home', 'stopped'))).toBe(false);
  expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
});

test('a stopped session claimed by another process is skipped while later sessions retire', async () => {
  const held = seedHosted();
  const next = seedHosted();
  const ready = join(home, 'claim-ready');
  const script = join(home, 'claim-owner.mts');
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';
import {tryAcquireClaim} from ${JSON.stringify(new URL('../../core/ownership-claim.ts', import.meta.url).href)};
const claim=tryAcquireClaim({root:${JSON.stringify(join(deviceHostRoot(), `${held.id}.claims`))},mode:'exclusive'});
if(!claim.acquired)throw new Error('No fixture claim');
writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
  );
  const child = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(errors || 'Claim owner exited');
      expect(existsSync(ready)).toBe(true);
    });
    await expect(host.reconcileStopped()).resolves.toBeUndefined();
    expect(existsSync(join(deviceHostArea(held.id), 'home', 'stopped'))).toBe(false);
    expect(JSON.parse(readFileSync(join(deviceHostArea(held.id), 'home', 'created-devices.json'), 'utf8')).ios).toEqual(
      [(held.device as { udid: string }).udid],
    );
    expectRetired(next.id);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

test.each(['fail-stop', 'uncertain-stop', 'wrong-stop'])(
  'a %s retirement keeps its stopped journal and does not abort later sessions',
  async (deviceType) => {
    const failed = seedHosted({ deviceType });
    const next = seedHosted();
    const journal = readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await host.reconcileStopped();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain(failed.id);
      expect(readHostedSessions().find((record) => record.id === failed.id)?.state).toBe('stopped');
      expect(
        JSON.parse(readFileSync(join(deviceHostArea(failed.id), 'home', 'created-devices.json'), 'utf8')).ios,
      ).toHaveLength(1);
      expectRetired(next.id);
      expect(readFileSync(join(deviceHostRoot(), 'sessions.json'), 'utf8')).toBe(journal);
    } finally {
      stderr.mockRestore();
    }
  },
);

test('close waits for an in-flight retirement and prevents further reconciliation workers', async () => {
  const record = seedHosted({ deviceType: 'delayed-stop' });
  const next = seedHosted();
  const area = join(deviceHostArea(record.id), 'home');
  const reconciliation = host.reconcileStopped();
  expect(host.reconcileStopped()).toBe(reconciliation);
  await vi.waitFor(() => expect(existsSync(join(area, 'stopped'))).toBe(true));
  let closed = false;
  const closing = host.close().then(() => (closed = true));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    expect(readClaimSet(join(deviceHostRoot(), `${record.id}.claims`)).live).toHaveLength(1);
  } finally {
    writeFileSync(join(area, 'release-stop'), 'release');
    await closing;
  }
  expectRetired(record.id);
  await host.reconcileStopped();
  expect(existsSync(join(deviceHostArea(next.id), 'home', 'stopped'))).toBe(false);
});
