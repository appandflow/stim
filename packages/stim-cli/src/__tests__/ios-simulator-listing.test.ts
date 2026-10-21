import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticDevicePlacement } from '../device-host/auto-placement.ts';
import { upsertProject } from '../workspace/config.ts';
import {
  createIosSimSnapshot,
  listAllIosSimsAsync,
  listIosDeviceTypesAsync,
  listIosRuntimesAsync,
} from '../devices/ios.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const ALL = JSON.parse(readFileSync(new URL('./fixtures/simctl-list-all.json', import.meta.url), 'utf8'));

function simctl(all = ALL) {
  const calls: string[][] = [];
  setExecutor({
    runFile: (_file: string, args: string[]) => {
      calls.push(args);
      const section = args[2];
      return JSON.stringify(section === undefined || section === '--json' ? all : { [section]: all[section] });
    },
  });
  return calls;
}

afterEach(() => resetExecutor());

test('one simctl list serves the simulators, runtimes and device types that three separate lists give', async () => {
  const calls = simctl();
  const separate = {
    sims: await listAllIosSimsAsync({ includeUnavailable: true }),
    runtimes: await listIosRuntimesAsync(),
    deviceTypes: await listIosDeviceTypesAsync(),
  };
  expect(calls).toHaveLength(3);
  expect(separate.sims.map((sim) => sim.available)).toContain(false);
  expect(separate.runtimes).toHaveLength(2);

  calls.length = 0;
  const snapshot = createIosSimSnapshot();
  const [runtimes, deviceTypes, sims] = await Promise.all([
    listIosRuntimesAsync({ snapshot }),
    listIosDeviceTypesAsync({ snapshot }),
    snapshot.readAsync?.(),
  ]);
  expect({ sims, runtimes, deviceTypes }).toEqual(separate);
  expect(calls).toEqual([['simctl', 'list', '--json']]);
});

test('invalidation lists the simulators again and keeps the runtimes and device types', async () => {
  const calls = simctl();
  const snapshot = createIosSimSnapshot();
  assert(snapshot.readAsync && snapshot.deviceTypes);
  const first = await snapshot.readAsync();
  const deviceTypes = await snapshot.deviceTypes();
  expect(first).toHaveLength(5);
  expect(calls).toHaveLength(1);

  const moved = structuredClone(ALL);
  const udid = moved.devices['com.apple.CoreSimulator.SimRuntime.iOS-27-0'][0].udid;
  moved.devices['com.apple.CoreSimulator.SimRuntime.iOS-27-0'][0].state = 'Booted';
  const after = simctl(moved);
  snapshot.invalidate();
  const sims = await snapshot.readAsync();
  expect(sims.find((sim) => sim.udid === udid)?.state).toBe('Booted');
  expect(after).toEqual([['simctl', 'list', 'devices', '--json']]);
  expect(await snapshot.deviceTypes()).toBe(deviceTypes);
  expect(after).toHaveLength(1);
});

test('auto placement counts local devices from the simulators the run already listed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-listing-'));
  const root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = join(home, 'stim');
  try {
    upsertProject(root, { platforms: { ios: { owned: true, deviceUdid: 'U1' } }, deviceSlots: {} });
    const calls = simctl();
    const sim = {
      udid: 'U1',
      name: 'stim-fixture',
      state: 'Booted',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      available: true,
    };
    const placed = await automaticDevicePlacement(
      { root, slot: 'default', platform: 'ios', selectors: {}, noWait: true, localSims: [sim] },
      { read: () => ({}), write: () => {} },
    );
    expect(placed).toMatchObject({ sticky: true, placement: { decision: 'local' } });
    expect(calls).toEqual([]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
