import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readWorkspaceLaunches, type WorkspaceLaunchRecord } from '../supervisor/state.ts';
import { siblingPlatformSlots } from '../engine/slot-launch.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject } from '../workspace/config.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';

let stimHome: string;
let root: string;

beforeEach(() => {
  stimHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  root = mkdtempSync(join(tmpdir(), 'stim-project-'));
  process.env.STIM_HOME = stimHome;
});

afterEach(() => {
  rmSync(stimHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function launch(appId: string, deviceId: string): WorkspaceLaunchRecord {
  return {
    appId,
    deviceId,
    metroPort: 8082,
    release: false,
    launchedAt: '2026-09-04T12:00:00.000Z',
  };
}

test('invalid launch entries are ignored instead of becoming reload targets', () => {
  writeWorkspaceState(root, {
    launches: {
      ios: { appId: 'com.example.ios' },
      'android:invalid-runtime': { ...launch('native', 'emulator-5556'), metroPort: null, runtime: 'unknown' },
      'android:contradictory-runtime': { ...launch('native', 'emulator-5558'), runtime: 'process' },
      android: launch('com.example.android', 'emulator-5554'),
    },
  });

  expect(readWorkspaceLaunches(root)).toEqual({ android: launch('com.example.android', 'emulator-5554') });
});

test('a sibling whose device state cannot be read counts as running, so it can never lend its bundle', async () => {
  upsertProject(root, { deviceSlots: { tablet: { ios: { deviceUdid: 'TABLET', owned: true } } } });
  setExecutor({
    runFileAsync: async () => {
      throw new Error('simctl timed out');
    },
  });
  try {
    expect(await siblingPlatformSlots(root, 'ios')).toEqual(['tablet']);
  } finally {
    resetExecutor();
  }
});

test('sibling discovery leaves the event loop available while waiting for the device listing', async () => {
  upsertProject(root, { deviceSlots: { tablet: { ios: { deviceUdid: 'TABLET', owned: true } } } });
  let resolveListing!: (value: string) => void;
  const listing = new Promise<string>((resolve) => {
    resolveListing = resolve;
  });
  setExecutor({ runFileAsync: () => listing });
  try {
    let completed = false;
    const siblings = siblingPlatformSlots(root, 'ios').then((slots) => {
      completed = true;
      return slots;
    });
    await setImmediate();
    expect(completed).toBe(false);
    resolveListing(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
            { udid: 'TABLET', name: 'stim-tablet', state: 'Booted', isAvailable: true },
          ],
        },
      }),
    );
    expect(await siblings).toEqual(['tablet']);
  } finally {
    resolveListing('{}');
    resetExecutor();
  }
});

test.each([
  ['cannot be read', '', ['second']],
  ['names another AVD', 'stim-other\nOK', []],
  ['names the sibling', 'stim-second\nOK', ['second']],
])('an Android sibling is judged from the running emulators when an AVD name %s', async (_case, avdName, siblings) => {
  upsertProject(root, { deviceSlots: { second: { android: { avdName: 'stim-second', owned: true } } } });
  setExecutor({
    runFileAsync: async () => 'List of devices attached\nemulator-5554\tdevice\n',
    runFileQuietAsync: async () => avdName,
  });
  try {
    expect(await siblingPlatformSlots(root, 'android')).toEqual(siblings);
  } finally {
    resetExecutor();
  }
});
