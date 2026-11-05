import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceId } from '@stim-cli/core';
import type { WorkspaceState } from '@stim-cli/core/state';
import {
  agentDeviceArgs,
  needsRevive,
  planAgentDevice,
  unselectedArgs,
  workspaceDevices,
  type WorkspaceDevice,
} from '../commands/agent-device.ts';
import { deviceLeasePath } from '../engine/device-lease.ts';
import type { ProjectRecord } from '../workspace/config.ts';

const sim: WorkspaceDevice = { platform: 'ios', slot: 'default', kind: 'owned', id: 'SIM-1', name: 'stim-app' };
const emulator: WorkspaceDevice = {
  platform: 'android',
  slot: 'default',
  kind: 'owned',
  id: 'emulator-5554',
  name: 'stim-app',
  avdName: 'stim-app',
};
const tablet: WorkspaceDevice = { ...sim, slot: 'tablet', id: 'SIM-2' };

function args(devices: WorkspaceDevice[], argv: string[], root = '/work/app') {
  const plan = planAgentDevice(devices, argv);
  if ('refusal' in plan) return plan;
  return agentDeviceArgs(plan, root);
}

describe('planAgentDevice', () => {
  test('injects the platform, the device and a per-slot session, and strips --slot', () => {
    expect(args([sim, tablet], ['press', '@e3', '--slot', 'tablet', '--json'])).toEqual({
      args: ['press', '@e3', '--json', '--platform', 'ios', '--udid', 'SIM-2', '--session', 'stim-tablet-ios'],
      session: 'stim-tablet-ios',
    });
    expect(args([emulator], ['snapshot', '-i', '--session', 'mine'])).toEqual({
      args: ['snapshot', '-i', '--platform', 'android', '--serial', 'emulator-5554', '--session', 'mine'],
      session: 'mine',
    });
  });

  test('device status gets the device but no session, which agent-device refuses for it', () => {
    expect(args([sim], ['device', 'status', '--stale'])).toEqual({
      args: ['device', 'status', '--stale', '--platform', 'ios', '--udid', 'SIM-1'],
      session: null,
    });
  });

  test('a hosted default session is stable within a workspace and differs between workspaces', () => {
    const hosted: WorkspaceDevice = {
      ...sim,
      kind: 'hosted',
      id: null,
      remoteConfig: '/stim/hosted-ios/default/c.json',
    };
    const sessionOf = (root: string, extra: string[] = []) => {
      const built = args([hosted], ['snapshot', ...extra], root);
      if ('refusal' in built) throw new Error(built.refusal.message);
      return built.args[built.args.indexOf('--session') + 1];
    };
    expect(sessionOf('/work/app')).toBe(sessionOf('/work/app'));
    expect(sessionOf('/work/app')).not.toBe(sessionOf('/work/app-2'));
    expect(sessionOf('/work/app-2', ['--session', 'mine'])).toBe('mine');
  });

  test("accepts the workspace's own UDID or serial and refuses another device", () => {
    expect(args([sim], ['press', '@e1', '--udid', 'SIM-1'])).toMatchObject({ session: 'stim-default-ios' });
    for (const argv of [
      ['press', '@e1', '--udid', 'OTHER'],
      ['press', '@e1', '--serial=emulator-5556'],
      ['press', '@e1', '--device', 'iPhone 17'],
      ['press', '@e1', '--remote-config', '/tmp/other.json'],
    ]) {
      expect(planAgentDevice([sim, emulator], argv)).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
    }
  });

  test('refuses boot and shutdown, because Stim owns the device lifecycle, wherever the command sits', () => {
    expect(planAgentDevice([sim], ['boot', '--platform', 'ios'])).toMatchObject({
      refusal: { code: 'STIM_BAD_ARG', remedy: expect.stringContaining('stim revive') },
    });
    for (const argv of [
      ['--level', 'digest', 'boot'],
      ['--timeout', '60000', 'boot'],
      ['--some-future-flag', 'value', 'shutdown'],
      ['close', '--shutdown'],
    ]) {
      expect(planAgentDevice([sim], argv)).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
    }
  });

  test('asks for --platform when the slot has both, and picks the one asked for', () => {
    expect(planAgentDevice([sim, emulator], ['snapshot'])).toMatchObject({
      refusal: { code: 'STIM_BAD_ARG', remedy: 'Pass --platform ios or --platform android.' },
    });
    expect(planAgentDevice([sim, emulator], ['snapshot', '--platform', 'android'])).toMatchObject({
      device: emulator,
    });
    expect(planAgentDevice([sim], ['snapshot', '--platform', 'macos'])).toMatchObject({
      refusal: { code: 'STIM_BAD_ARG' },
    });
  });

  test('refuses a workspace with no device, or whose emulator is not running', () => {
    expect(planAgentDevice([], ['snapshot'])).toMatchObject({ refusal: { code: 'STIM_NO_DEVICE' } });
    expect(args([{ ...emulator, id: null }], ['snapshot'])).toMatchObject({
      refusal: { code: 'STIM_NO_DEVICE', remedy: expect.stringContaining('stim android') },
    });
  });

  test("a hosted session gets its remote config instead of a device, and a leased phone wins over the slot's simulator", () => {
    const hosted: WorkspaceDevice = {
      ...sim,
      kind: 'hosted',
      id: null,
      remoteConfig: '/stim/hosted-ios/default/c.json',
    };
    expect(args([hosted], ['press', '@e1', '--remote-config', '/stim/hosted-ios/default/c.json'])).toEqual({
      args: [
        'press',
        '@e1',
        '--session',
        `stim-default-ios-${workspaceId('/work/app').slice(0, 8)}`,
        '--remote-config',
        '/stim/hosted-ios/default/c.json',
      ],
      session: null,
    });
    expect(args([hosted], ['snapshot', '-i', '--session', 'mine'])).toMatchObject({
      args: ['snapshot', '-i', '--session', 'mine', '--remote-config', '/stim/hosted-ios/default/c.json'],
    });
    expect(args([hosted], ['device', 'status'])).toMatchObject({
      args: ['device', 'status', '--remote-config', '/stim/hosted-ios/default/c.json'],
    });
    expect(args([{ ...hosted, remoteConfig: null }], ['snapshot'])).toMatchObject({
      refusal: { code: 'STIM_NO_DEVICE' },
    });
    const phone: WorkspaceDevice = { ...sim, kind: 'physical', id: 'PHONE-1' };
    expect(planAgentDevice([sim, phone], ['snapshot'])).toMatchObject({ device: phone });
  });

  test('names the element a targeted command acts on', () => {
    expect(planAgentDevice([sim], ['press', '@e7~s2', '--settle'])).toMatchObject({ target: '@e7~s2' });
    expect(planAgentDevice([sim], ['--config', 'c.json', 'press', '--settle', '@e7'])).toMatchObject({
      command: 'press',
      target: '@e7',
    });
    expect(planAgentDevice([sim], ['fill', 'label="Email"', 'me@example.com'])).toMatchObject({
      target: 'label="Email"',
    });
    expect(planAgentDevice([sim], ['scroll', 'down'])).toMatchObject({ target: undefined });
    expect(planAgentDevice([sim], ['press', '--settle-quiet', '300', '@e7'])).toMatchObject({ target: '@e7' });
  });
});

test('a command that selects no device runs without one, keeping the agent session and dropping --slot', () => {
  expect(unselectedArgs(['daemon', 'status', '--slot', 'tablet', '--session', 'mine'])).toEqual([
    'daemon',
    'status',
    '--session',
    'mine',
  ]);
  expect(unselectedArgs(['press', '@e1'])).toBeNull();
});

describe('workspaceDevices', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-agent-device-'));
    vi.stubEnv('STIM_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  test('reads owned devices from the project, hosted sessions and live leases from the state, and nothing else', () => {
    const project: ProjectRecord = {
      platforms: {
        ios: { deviceUdid: 'SIM-1', deviceName: 'stim-app', owned: true },
        android: { avdName: 'stim-app' },
      },
      deviceSlots: { tablet: { android: { avdName: 'stim-tab', owned: true } } },
    };
    const lease = (id: string, token: string, expiresAt: string) => {
      mkdirSync(join(home, 'device-locks'), { recursive: true });
      writeFileSync(
        deviceLeasePath('ios', id),
        JSON.stringify({ version: 1, platform: 'ios', id, deviceName: 'Phone', holder: 'x', token, expiresAt }),
      );
    };
    lease('PHONE-1', 't1', '2026-11-03T12:00:00.000Z');
    lease('PHONE-2', 't2', '2026-11-03T09:00:00.000Z');
    const state: WorkspaceState = {
      deviceLeases: { 'ios:phone': { id: 'PHONE-1', token: 't1' }, 'ios:old': { id: 'PHONE-2', token: 't2' } },
    };
    expect(workspaceDevices(project, state, Date.parse('2026-11-03T10:00:00.000Z'))).toEqual([
      { platform: 'ios', slot: 'default', kind: 'owned', id: 'SIM-1', name: 'stim-app' },
      { platform: 'android', slot: 'tablet', kind: 'owned', id: null, name: 'stim-tab', avdName: 'stim-tab' },
      { platform: 'ios', slot: 'phone', kind: 'physical', id: 'PHONE-1', name: 'Phone' },
    ]);
  });
});

describe('needsRevive', () => {
  const project: ProjectRecord = { metroPort: 8082 };
  const idle: WorkspaceState = { devServerStop: { reason: 'idle', at: '2026-11-01T10:30:00.000Z', idleMinutes: 15 } };

  test('revives before the command after an idle stop of Metro or of the device, and not once it is revived', () => {
    expect(needsRevive(project, idle, sim)).toBe(true);
    expect(needsRevive(project, { deviceIdleShutdowns: { ios: { at: 'x', idleMinutes: 15 } } }, sim)).toBe(true);
    expect(needsRevive(project, {}, sim)).toBe(false);
    expect(needsRevive(project, idle, { ...sim, kind: 'physical' })).toBe(false);
  });
});
