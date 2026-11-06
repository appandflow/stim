import { PEER } from '@stim-cli/core/protocol';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { keyFingerprint } from '@stim-cli/core/noise-session';
import { readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import remoteCommand from '../commands/remote.ts';
import { inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectBuildMachines } from '../offload/build-machines.ts';
import type { Endpoint, HelloReply, TailnetMachineIo } from '../offload/tailnet.ts';
import { loadConfig, writeConfigSetting } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import type { Upstream } from '@stim-cli/server/hosted-relay';

const updating = vi.hoisted(() => ({
  construct: vi.fn<(target: Endpoint, serverKey: string) => void>(),
  open: vi.fn<Upstream['open']>(),
  request: vi.fn<Upstream['request']>(),
  close: vi.fn<Upstream['close']>(),
}));
vi.mock('@stim-cli/server/hosted-relay', () => ({
  Upstream: class {
    channel = 'next';
    open = updating.open;
    request = updating.request;
    close = updating.close;
    constructor(target: Endpoint, serverKey: string) {
      updating.construct(target, serverKey);
    }
  },
}));

let home: string;
let cwd: string;
const startDir = process.cwd();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-remote-command-'));
  cwd = mkdtempSync(join(tmpdir(), 'stim-remote-cwd-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(startDir);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const SERVER_KEY = 'S'.repeat(42) + 'A';

const status = {
  BackendState: 'Running',
  Self: { HostName: 'laptop' },
  Peer: {
    mini: { ID: 'nMini', DNSName: 'mini.tail1.ts.net.', TailscaleIPs: ['100.64.0.7'], OS: 'macOS' },
    studio: { ID: 'nStudio', DNSName: 'studio.tail1.ts.net.', TailscaleIPs: ['100.64.0.9'], OS: 'macOS' },
  },
};
const notYet: HelloReply = { error: { code: 'unknown-secret', message: 'not yet' } };
const granted = (capability: string): HelloReply => ({
  result: { capabilities: [capability], peer: PEER, device: { id: 'dev-mini', name: 'laptop' } },
  serverKey: SERVER_KEY,
});

function fakeIo(replies: HelloReply[]): TailnetMachineIo {
  return { status: () => status, hello: () => Promise.resolve(replies.shift() ?? { failed: 'no reply scripted' }) };
}

async function approveMini(): Promise<void> {
  writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
  await inspectBuildMachines({ fix: true }, fakeIo([notYet]), ['mini']);
  await inspectBuildMachines({ fix: false }, fakeIo([granted('build')]), ['mini']);
  await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]), ['mini']);
  await inspectDeviceHostMachines({ fix: false }, fakeIo([granted('device-host')]), ['mini']);
}

async function remote(io: TailnetMachineIo, ...args: string[]): Promise<string> {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const program = new Command().exitOverride();
  remoteCommand(program, '9.9.9', io);
  await program.parseAsync(['remote', ...args], { from: 'user' });
  return out.join('\n');
}

test('add appends to remote.machines outside an app and keeps the other machines and their approvals', async () => {
  await approveMini();
  const out = await remote(fakeIo([notYet, notYet]), 'add', 'studio');
  expect(loadConfig()?.remote?.machines).toEqual(['mini', 'studio']);
  expect(readBuildMachines().map((each) => [each.machine, each.state])).toEqual([
    ['mini', 'approved'],
    ['studio', 'pending'],
  ]);
  expect(readDeviceHostMachines().map((each) => [each.machine, each.state])).toEqual([
    ['mini', 'approved'],
    ['studio', 'pending'],
  ]);
  const ticket = readBuildMachines().find((each) => each.machine === 'studio')?.ticket;
  expect(out).toContain(`STIM_SETUP_TICKET=${ticket} `);
  expect(out).toContain('stim@9.9.9 setup');
  expect(process.exitCode).toBeUndefined();
});

test('add refuses a name that is not a machine entry and writes nothing', async () => {
  writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
  await remote(fakeIo([]), 'add', 'bad;name');
  expect(process.exitCode).toBe(1);
  expect(loadConfig()?.remote?.machines).toEqual(['mini']);
  expect(readBuildMachines()).toEqual([]);
});

test('update resolves an approved worker, selects its channel and prints its staged version', async () => {
  await approveMini();
  const { request, close } = updating;
  updating.open.mockResolvedValue(undefined);
  request.mockResolvedValueOnce({ result: { state: 'installing' } }).mockResolvedValueOnce({
    result: {
      running: null,
      last: { ok: true, message: 'Build bbbbbbbbbbbb is staged; the engine switches once running work drains.' },
    },
  });
  vi.spyOn(getExecutor(), 'runFileAsync').mockResolvedValue(
    JSON.stringify({
      versions: ['9.9.0', '9.10.0', '9.11.0-next.1'],
      'dist-tags': { latest: '9.10.0', next: '9.11.0-next.1' },
    }),
  );
  const out = await remote(fakeIo([]), 'update', 'mini');
  expect(updating.construct).toHaveBeenCalledWith(
    {
      url: 'wss://100.64.0.7:7443',
      servername: 'mini.tail1.ts.net',
      host: 'mini.tail1.ts.net:7443',
    },
    SERVER_KEY,
  );
  expect(request).toHaveBeenCalledWith('engine.update', { version: '9.11.0-next.1' });
  expect(out).toContain('mini: stim 9.11.0-next.1. Build bbbbbbbbbbbb is staged');
  expect(close).toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

test('list --json gives each machine its server key fingerprint, reachability and the revoke command for there', async () => {
  await approveMini();
  await remote(fakeIo([notYet, notYet]), 'add', 'studio');
  writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini', 'studio', 'local:127.0.0.1:1']);
  vi.restoreAllMocks();
  const unreachable: HelloReply = { failed: 'connection refused' };
  const out = await remote(
    fakeIo([granted('build'), unreachable, granted('device-host'), unreachable]),
    'list',
    '--json',
  );
  const { machines }: { machines: Record<string, unknown>[] } = JSON.parse(out);
  expect(
    machines.map(({ machine, serverKeyFingerprint, reachability, revoke }) => ({
      machine,
      serverKeyFingerprint,
      reachability,
      revoke,
    })),
  ).toEqual([
    {
      machine: 'mini',
      serverKeyFingerprint: keyFingerprint(Buffer.from(SERVER_KEY, 'base64url')),
      reachability: 'reachable',
      revoke: ['stim pairings revoke dev-mini'],
    },
    { machine: 'studio', serverKeyFingerprint: null, reachability: 'unreachable', revoke: [] },
    { machine: 'local:127.0.0.1:1', serverKeyFingerprint: null, reachability: 'unknown', revoke: [] },
  ]);
});

async function listJson(io: TailnetMachineIo): Promise<Record<string, unknown>[]> {
  const out = await remote(io, 'list', '--json');
  const { machines }: { machines: Record<string, unknown>[] } = JSON.parse(out);
  return machines;
}

test('list --json reports a changed key over another approval that still answers', async () => {
  await approveMini();
  vi.restoreAllMocks();
  const mismatch: HelloReply = { error: { code: 'server-key-mismatch', message: 'key changed' } };
  const [mini] = await listJson(fakeIo([mismatch, granted('device-host')]));
  expect(mini).toMatchObject({ build: { state: 'key-changed' }, deviceHost: { state: 'approved' } });
  expect(mini?.reachability).toBe('key-changed');
});

test('list --json counts a local machine that answered with an unconfirmed key as reachable', async () => {
  await remote(fakeIo([notYet, notYet]), 'add', 'local:10.0.0.92');
  vi.restoreAllMocks();
  const [machine] = await listJson(fakeIo([granted('build'), granted('device-host')]));
  expect(machine).toMatchObject({ build: { state: 'key-unconfirmed' }, reachability: 'reachable' });
});

test('list --json still prints one payload when the device-host credentials cannot be read', async () => {
  await approveMini();
  writeFileSync(join(home, 'device-host-machines.json'), '{not json');
  vi.restoreAllMocks();
  const [mini] = await listJson(fakeIo([granted('build')]));
  expect(process.exitCode).toBeUndefined();
  expect(mini).toMatchObject({
    deviceHost: { state: 'credentials-unavailable' },
    serverKeyFingerprint: keyFingerprint(Buffer.from(SERVER_KEY, 'base64url')),
    revoke: ['stim pairings revoke dev-mini'],
  });
});

test('remove drops the entry and its credentials, keeps the others, and prints the revoke command for there', async () => {
  await approveMini();
  await remote(fakeIo([notYet, notYet]), 'add', 'studio');
  vi.restoreAllMocks();
  const out = await remote(fakeIo([]), 'remove', 'mini');
  expect(loadConfig()?.remote?.machines).toEqual(['studio']);
  expect(readBuildMachines().map((each) => each.machine)).toEqual(['studio']);
  expect(readDeviceHostMachines().map((each) => each.machine)).toEqual(['studio']);
  expect(out).toContain('stim pairings revoke dev-mini');
});

test('remove --json names an unreadable hosting store and preserves the machine and credentials', async () => {
  await approveMini();
  const store = join(home, 'device-host-machines.json');
  const corrupt = '{"version": 99';
  writeFileSync(store, corrupt);
  const out = await remote(fakeIo([]), 'remove', 'mini', '--json');
  expect(JSON.parse(out)).toMatchObject({
    code: 'STIM_BAD_ARG',
    message: expect.stringContaining(store),
    remedy: expect.stringContaining('trusted backup'),
  });
  expect(process.exitCode).toBe(1);
  expect(loadConfig()?.remote?.machines).toEqual(['mini']);
  expect(readBuildMachines().map((each) => each.machine)).toEqual(['mini']);
  expect(readFileSync(store, 'utf8')).toBe(corrupt);
});

test('remove keeps the credentials when the setting refuses to drop the last enabled build pool member', async () => {
  await approveMini();
  writeConfigSetting({ scope: 'machine' }, 'remote.buildPoolDisabled', ['local']);
  await remote(fakeIo([]), 'remove', 'mini');
  expect(process.exitCode).toBe(1);
  expect(loadConfig()?.remote?.machines).toEqual(['mini']);
  expect(readBuildMachines().map((each) => each.machine)).toEqual(['mini']);
  expect(readDeviceHostMachines().map((each) => each.machine)).toEqual(['mini']);
});
