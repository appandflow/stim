import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { PlacementProbe } from '../device-host/placement.ts';
import { automaticDevicePlacement } from '../device-host/auto-placement.ts';
import { planHostedDevice } from '../device-host/plan-placement.ts';
import { saveConfig } from '../workspace/config.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-plan-placement-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  delete process.env.STIM_REMOTE_BUILD;
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

test('a named machine plans with the architecture its offer gives', async () => {
  const planned = await planHostedDevice({
    ...base,
    machine: 'mini',
    sameKey: () => true,
    deps: { probe: async (machine) => offer(machine, iosChoice('x86_64')) },
  });
  expect(planned).toMatchObject({ kind: 'hosted', placement: 'on mini', choice: { architecture: 'x86_64' } });
});

test('a named machine that cannot be reached or has no device is unknown, not an error', async () => {
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

test('auto staying on this machine names the machines it may use and flags a differing architecture', async () => {
  const stayLocal = {
    automatic: async () => ({
      target: null,
      placement: { decision: 'local' as const, reason: '' },
      code: 'this-mac-free',
      skipped: [],
    }),
  };
  const same = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: () => true,
    deps: { ...stayLocal, machines: () => ['mini'], probe: async (machine) => offer(machine, iosChoice('arm64')) },
  });
  expect(same).toEqual({ kind: 'local', placement: 'this machine; auto may use mini' });
  const differs = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: async (choice) => 'architecture' in choice && choice.architecture === 'arm64',
    deps: { ...stayLocal, machines: () => ['mini'], probe: async (machine) => offer(machine, iosChoice('x86_64')) },
  });
  expect(differs).toMatchObject({
    kind: 'local',
    placement: expect.stringContaining('mini, which builds for another architecture'),
  });
});

const noAutomatic = async () => {
  throw new Error('placement must not run');
};

test('an invalid STIM_REMOTE_BUILD is refused as that variable before placement runs', async () => {
  process.env.STIM_REMOTE_BUILD = 'bad word';
  const planned = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: () => true,
    deps: { automatic: noAutomatic },
  });
  expect(planned).toEqual({
    kind: 'refused',
    code: 'STIM_BAD_ARG',
    message:
      'Invalid STIM_REMOTE_BUILD value "bad word". Expected local, auto, remote, remote-only, or a tailnet machine name.',
    remedy: 'Fix the environment variable, or unset it and run `stim settings set remote.build <value>`.',
  });
});

test('an invalid remote.build setting is refused as that setting, and a valid environment value overrides it', async () => {
  saveConfig({ version: 2, projects: {}, repos: {}, remote: { build: 'bad word' } });
  const planned = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: () => true,
    deps: { automatic: noAutomatic },
  });
  expect(planned).toMatchObject({
    kind: 'refused',
    code: 'STIM_BAD_ARG',
    message:
      'Invalid remote.build setting "bad word". Expected local, auto, remote, remote-only, or a tailnet machine name.',
  });
  process.env.STIM_REMOTE_BUILD = 'local';
  const overridden = await planHostedDevice({
    ...base,
    machine: 'auto',
    sameKey: () => true,
    deps: { automatic: noAutomatic },
  });
  expect(overridden).toEqual({ kind: 'unknown', reason: 'placement must not run' });
});

test('remote-only with no remote machines plans the STIM_HOSTING_REFUSED a run gives, with a remedy that adds a machine', async () => {
  const planned = await planHostedDevice({
    ...base,
    machine: 'auto',
    placement: 'remote-only',
    sameKey: () => true,
    deps: {
      automatic: (args, deps) =>
        automaticDevicePlacement(args, {
          ...deps,
          machines: () => [],
          peek: () => ({ count: 0, max: 3, queued: 0, localLive: false }),
          capacity: () => ({ cpus: 4, loadPerCore: 0, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
          memory: () => 'normal',
          budget: async () => null,
        }),
    },
  });
  expect(planned).toEqual({
    kind: 'refused',
    code: 'STIM_HOSTING_REFUSED',
    message: 'no remote machines configured; remote-only never runs here',
    remedy: 'Add an approved Mac to remote.machines (stim guide settings), or select a placement that may run here.',
  });
});
