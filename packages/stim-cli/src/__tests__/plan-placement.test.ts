import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { PlacementProbe } from '../device-host/placement.ts';
import { planHostedDevice } from '../device-host/plan-placement.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-plan-placement-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const iosChoice = (architecture: 'arm64' | 'x86_64') => ({
  deviceType: 'iPhone 16',
  deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  runtime: '18.0',
  runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
  architecture,
});
const offer = (machine: string, choice: ReturnType<typeof iosChoice> | null): { probe: PlacementProbe } => ({
  probe: {
    machine,
    offer: {
      platform: 'ios',
      choice,
      declined: choice ? null : 'no runtime',
      capacity: { available: 1 },
      resources: { loadPerCore: 0.1, memoryFreeBytes: 1, memoryPressure: 'normal' },
    },
  },
});
const base = { root: '/project', slot: 'default', platform: 'ios' as const, selectors: {} };

test('a named Mac plans with the architecture its offer gives', async () => {
  const planned = await planHostedDevice({
    ...base,
    machine: 'mini',
    sameKey: () => true,
    deps: { probe: async (machine) => offer(machine, iosChoice('x86_64')) },
  });
  expect(planned).toMatchObject({ kind: 'hosted', placement: 'on mini', choice: { architecture: 'x86_64' } });
});

test('a named Mac that cannot be reached or has no device is unknown, not an error', async () => {
  const unreachable = await planHostedDevice({
    ...base,
    machine: 'mini',
    sameKey: () => true,
    deps: { probe: async (machine) => ({ probe: { machine, failure: 'connect timed out' } }) },
  });
  expect(unreachable).toEqual({
    kind: 'unknown',
    reason: 'mini did not give a ios device (connect timed out)',
  });
  const none = await planHostedDevice({
    ...base,
    machine: 'mini',
    sameKey: () => true,
    deps: { probe: async (machine) => offer(machine, null) },
  });
  expect(none).toMatchObject({ kind: 'unknown' });
});

test('auto staying on this Mac names the Macs it may use and flags a differing architecture', async () => {
  const stayLocal = {
    automatic: async () => ({ target: null, placement: { decision: 'local' as const, reason: '' }, skipped: [] }),
  };
  const same = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: () => true,
    deps: { ...stayLocal, machines: () => ['mini'], probe: async (machine) => offer(machine, iosChoice('arm64')) },
  });
  expect(same).toEqual({ kind: 'local', placement: 'this Mac; auto may use mini' });
  const differs = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: (choice) => 'architecture' in choice && choice.architecture === 'arm64',
    deps: { ...stayLocal, machines: () => ['mini'], probe: async (machine) => offer(machine, iosChoice('x86_64')) },
  });
  expect(differs).toMatchObject({
    kind: 'local',
    placement: expect.stringContaining('mini, which builds for another architecture'),
  });
});
