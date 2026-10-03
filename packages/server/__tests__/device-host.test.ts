import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceHostArea, deviceHostRoot, readHostedSessions } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { DeviceHost } from '../src/device-host.ts';
import { protocolJsonSchema } from '../src/protocol.ts';
import { Ajv2020 } from 'ajv/dist/2020.js';

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
  const choice=request.platform==='ios' ? {deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64',udid:'not-a-device'} : {systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'};
  process.stdout.write(JSON.stringify({platform:request.platform,choice:declined?null:choice,declined,resources:{cpus:4,loadPerCore:0.5,memoryFreeBytes:1000,memoryPressure:'normal',workerDiskFreeBytes:null}}));
  process.exit(0);
}
const home = process.env.STIM_HOME;
const iosDevice = {udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
const device = input.platform === 'android' ? {avdName:'stim-hosted-'+input.session,serial:'emulator-'+input.consolePort,consolePort:input.consolePort,systemImage:'system-images;android-30;google_apis;arm64-v8a',deviceProfile:'pixel_6',architecture:'arm64-v8a'} : iosDevice;
const out = value => process.stdout.write(JSON.stringify(value));
if(input.mode === 'prepare') {
  writeFileSync(join(home,'entered'),String(process.pid));
  if(input.deviceType === 'refused' || input.deviceType === 'delayed-refusal') {
    if(input.deviceType === 'delayed-refusal') await new Promise(resolve=>setTimeout(resolve,150));
    out({state:'stopped',device:null,notice:'inventory unavailable'});
  }
  else {
    writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
    writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:input.platform==='android'?[]:[device.udid],android:input.platform==='android'?[device.avdName]:[],web:[]}));
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

test('Android reservations keep distinct ports and platform slots, reconnect without recreation and refuse iOS app routes', async () => {
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
  expect(
    host.appOffer('client', {
      session: android.id,
      attempt: 'app',
      bundleId: 'dev.fixture',
      mode: 'release',
      manifest: { sha256: 'a'.repeat(64), size: 2 },
    }),
  ).toHaveProperty('error.message', 'Hosted app delivery currently supports iOS sessions only.');
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
  for (const platform of ['ios', 'android']) {
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
