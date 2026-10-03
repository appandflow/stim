import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceHostArea, deviceHostRoot, readHostedSessions } from '@stim-cli/core/state';
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { DeviceHost } from '../src/device-host.ts';

const WORKER = `
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks));
const home = process.env.STIM_HOME;
const device = {udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
const out = value => process.stdout.write(JSON.stringify(value));
if(input.mode === 'prepare') {
  writeFileSync(join(home,'entered'),String(process.pid));
  if(input.deviceType === 'refused') { out({state:'stopped',device:null,notice:'inventory unavailable'}); }
  else {
    writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
    writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
    if(input.deviceType === 'hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
    else if(input.deviceType === 'lost') { process.exitCode=1; }
    else out({state:'ready',device});
  }
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
