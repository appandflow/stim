import { deviceTileName, deviceTileState } from '@/lib/device-tile';
import type { DeviceRef } from '@/lib/workspaces';
import type { EnvironmentState } from '@/protocol/types';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const env: EnvironmentState = { path: '/u/stim/apps/mobile', live: true, memoryMb: 0, warnings: [] };
const device = (extra: Partial<DeviceRef> = {}): DeviceRef => ({
  platform: 'ios',
  slot: 'default',
  id: 'udid',
  name: 'stim-x',
  model: 'iPhone 18 Pro 27.0',
  state: 'Booted',
  running: true,
  owned: true,
  physical: false,
  ...extra,
});

describe('deviceTileName', () => {
  it('splits the simulator runtime from the model', () => {
    expect(deviceTileName(device())).toEqual({ name: 'iPhone 18 Pro', detail: 'iOS 27.0' });
  });

  it('leaves a model without a runtime whole', () => {
    expect(deviceTileName(device({ model: 'iPhone 18' }))).toEqual({ name: 'iPhone 18', detail: null });
  });

  it('names an emulator by its device profile', () => {
    const android = device({ platform: 'android', model: 'Android Emulator', profile: 'pixel_9_pro' });
    expect(deviceTileName(android)).toEqual({ name: 'Pixel 9 Pro', detail: 'Emulator' });
    expect(deviceTileName({ ...android, profile: null })).toEqual({ name: 'Android Emulator', detail: null });
  });

  it('names a physical phone and Chrome', () => {
    expect(deviceTileName(device({ physical: true, name: 'Old iPhone', model: 'iPhone 12' }))).toEqual({
      name: 'Old iPhone',
      detail: 'iPhone 12',
    });
    expect(
      deviceTileName(
        device({ platform: 'web', model: 'Web', page: { url: 'http://localhost:8090/settings', error: null } }),
      ),
    ).toEqual({ name: 'Chrome', detail: 'localhost:8090/settings' });
  });
});

describe('deviceTileState', () => {
  const driven = { state: 'driven' as const, driver: { tool: 'agent-device', pid: 1, since: ago(4) }, basis: [] };

  it('puts a build on this device before anything else', () => {
    const building: EnvironmentState = {
      ...env,
      build: { state: 'running', platform: 'ios', slot: 'default', startedAt: ago(3) } as EnvironmentState['build'],
    };
    expect(deviceTileState(device({ activity: driven }), building, NOW)).toEqual({
      text: 'Building \u00B7 3:00',
      tone: 'brand',
    });
    expect(deviceTileState(device({ platform: 'android' }), building, NOW).text).toBe('Running');
  });

  it('names the tool and how long it has driven', () => {
    expect(deviceTileState(device({ activity: driven }), env, NOW)).toEqual({
      text: 'Driven by agent-device \u00B7 4m',
      tone: 'brand',
    });
  });

  it('keeps a driven device driven when its app stopped, and says when activity is unknown', () => {
    expect(deviceTileState(device({ activity: driven, app: { id: 'a', state: 'stopped' } }), env, NOW).tone).toBe(
      'brand',
    );
    expect(deviceTileState(device({ activity: { state: 'unknown', basis: [] } }), env, NOW)).toEqual({
      text: 'Activity unknown',
      tone: 'tertiary',
    });
  });

  it('flags a stopped app and a failed page', () => {
    expect(deviceTileState(device({ app: { id: 'a', state: 'stopped' } }), env, NOW)).toEqual({
      text: 'App not running',
      tone: 'warning',
    });
    expect(deviceTileState(device({ platform: 'web', page: { url: 'u', error: 'x' } }), env, NOW).tone).toBe('warning');
  });

  it('reports use, idleness, a lease and plain running', () => {
    const idle = (minutes: number) => ({ state: 'idle' as const, lastActivityAt: ago(minutes), basis: [] });
    expect(deviceTileState(device({ activity: { state: 'active', basis: [] } }), env, NOW).text).toBe('In use');
    expect(deviceTileState(device({ activity: idle(22) }), env, NOW)).toEqual({ text: 'Idle 22m', tone: 'tertiary' });
    expect(deviceTileState(device({ activity: idle(2) }), env, NOW).text).toBe('Running');
    expect(deviceTileState(device({ physical: true }), env, NOW)).toEqual({ text: 'Leased', tone: 'secondary' });
    expect(deviceTileState(device(), env, NOW)).toEqual({ text: 'Running', tone: 'success' });
  });
});
