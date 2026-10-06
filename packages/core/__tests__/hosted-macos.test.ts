import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceName } from '../index.ts';
import { readHostedMacosApp } from '../state/macos.ts';
import { parseHostedAgentGrant, parseHostedMacosDevice } from '../state/hosted-macos.ts';

test('a hosted macOS identity names exactly the host and one reserved app slot', () => {
  const device = { architecture: 'arm64', macosVersion: '27.0', appSlot: 1 };
  expect(parseHostedMacosDevice(device)).toEqual(device);
  for (const value of [
    { ...device, appSlot: 0 },
    { ...device, appSlot: 65 },
    { ...device, appSlot: 1.5 },
    { ...device, macosVersion: '27.0 beta' },
    { ...device, architecture: 'arm64e' },
    { ...device, udid: '12345678-1234-1234-1234-123456789abc' },
  ])
    expect(parseHostedMacosDevice(value)).toBeNull();
});

test('an agent grant is usable only for a known driver, one session route, and a bounded token', () => {
  const grant = {
    driver: 'agent-device',
    path: '/device-host/agent/12345678-1234-1234-1234-123456789abc/',
    token: 'a'.repeat(43),
    scope: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    lease: { tenant: 'stim.t', runId: 'run-1', clientId: 'agent', deviceKey: 'dev.example.app.hosted1@4242' },
  };
  expect(parseHostedAgentGrant(grant)).toEqual(grant);
  const ios = {
    ...grant,
    lease: { ...grant.lease, backend: 'ios-instance', deviceKey: 'ios:mobile:12345678-1234-1234-1234-123456789abc' },
  };
  expect(parseHostedAgentGrant(ios)).toEqual(ios);
  expect(parseHostedAgentGrant({ ...ios, lease: { ...ios.lease, backend: 'macos-app' } })).toBeNull();
  expect(parseHostedAgentGrant({ ...ios, lease: { ...ios.lease, deviceKey: grant.lease.deviceKey } })).toBeNull();
  expect(parseHostedAgentGrant({ driver: 'none' })).toEqual({ driver: 'none' });
  for (const value of [
    { driver: 'none', token: grant.token },
    { ...grant, driver: 'argent' },
    { ...grant, path: '/device-host/agent/../other/' },
    { ...grant, token: 'short' },
    { ...grant, extra: true },
    { ...grant, lease: undefined },
    { ...grant, lease: { ...grant.lease, deviceKey: 'dev.example.app.hosted1' } },
    { ...grant, lease: { ...grant.lease, tenant: 'a tenant' } },
  ])
    expect(parseHostedAgentGrant(value)).toBeNull();
});

describe('hosted macOS app state', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-hosted-macos-state-'));
    process.env.STIM_HOME = join(home, 'server-home');
  });
  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('finds the worker record through a symlink using the canonical workspace hash and not the server home', () => {
    const worker = join(home, 'worker');
    mkdirSync(join(worker, 'macos-app'), { recursive: true });
    const alias = join(home, 'alias');
    symlinkSync(worker, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const state = join(worker, 'workspaces', workspaceName(realpathSync(join(alias, 'macos-app'))));
    mkdirSync(state, { recursive: true });
    const record = {
      launchId: 'launch-1',
      arguments: [],
      product: 'Fixture',
      bundle: '/app/Fixture.app',
      bundleId: 'dev.stim.fixture.hosted1',
      executable: '/app/Fixture.app/Contents/MacOS/Fixture',
      build: { state: 'ok', startedAt: '2026-10-05T00:00:00Z' },
    };
    writeFileSync(join(state, 'state.json'), JSON.stringify({ macos: record }));
    expect(readHostedMacosApp(alias)).toEqual(record);
  });

  test('missing or malformed worker state cannot supply a capture target', () => {
    expect(readHostedMacosApp(home)).toBeNull();
    mkdirSync(join(home, 'macos-app'));
    expect(readHostedMacosApp(home)).toBeNull();
    const state = join(home, 'workspaces', workspaceName(realpathSync(join(home, 'macos-app'))));
    mkdirSync(state, { recursive: true });
    for (const text of ['broken', 'null', '[]', '{}', '{"macos":{"launchId":"incomplete"}}']) {
      writeFileSync(join(state, 'state.json'), text);
      expect(readHostedMacosApp(home)).toBeNull();
    }
  });
});
