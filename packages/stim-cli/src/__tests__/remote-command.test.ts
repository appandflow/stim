import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import remoteCommand from '../commands/remote.ts';
import { inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectBuildMachines } from '../offload/build-machines.ts';
import type { HelloReply, TailnetMachineIo } from '../offload/tailnet.ts';
import { loadConfig, writeConfigSetting } from '../workspace/config.ts';

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
  result: { capabilities: [capability], device: { id: 'dev-mini', name: 'laptop' } },
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
  expect(out).toContain('stim-server setup');
  expect(process.exitCode).toBeUndefined();
});

test('add refuses a name that is not a machine entry and writes nothing', async () => {
  writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
  await remote(fakeIo([]), 'add', 'bad;name');
  expect(process.exitCode).toBe(1);
  expect(loadConfig()?.remote?.machines).toEqual(['mini']);
  expect(readBuildMachines()).toEqual([]);
});

test('remove drops the entry and its credentials, keeps the others, and prints the revoke command for there', async () => {
  await approveMini();
  await remote(fakeIo([notYet, notYet]), 'add', 'studio');
  vi.restoreAllMocks();
  const out = await remote(fakeIo([]), 'remove', 'mini');
  expect(loadConfig()?.remote?.machines).toEqual(['studio']);
  expect(readBuildMachines().map((each) => each.machine)).toEqual(['studio']);
  expect(readDeviceHostMachines().map((each) => each.machine)).toEqual(['studio']);
  expect(out).toContain('stim-server devices revoke dev-mini');
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
