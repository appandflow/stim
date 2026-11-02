import assert from 'node:assert/strict';
import type { WorkspaceState } from '@stim-cli/core/state';
import { reviveLines, runRevive, type ReviveDeps } from '../commands/revive.ts';
import type { WorkspaceLaunchRecord } from '../supervisor/state.ts';
import type { ProjectRecord } from '../workspace/config.ts';

const APP = '/stim/build-cache/ios/key-debug-sim-arm64/App.app';

const iosLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.app',
  deviceId: 'U1',
  metroPort: 8082,
  release: false,
  launchedAt: '2026-11-01T10:00:00.000Z',
};

const project: ProjectRecord = {
  metroPort: 8082,
  platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
};

const idleState: WorkspaceState = {
  devServerStop: { reason: 'idle', at: '2026-11-01T10:30:00.000Z', idleMinutes: 15 },
  lastIosBuild: {
    platform: 'ios',
    status: 'ok',
    appPath: APP,
    bundleId: 'com.example.app',
    configuration: 'Debug',
    startedAt: '2026-11-01T09:59:00.000Z',
    fingerprint: 'f1',
    cacheKey: 'f1-debug-sim-arm64',
    cacheHit: 'local',
  },
};

const sim = (state: string) => ({ sim: { udid: 'U1', name: 'stim-app', state } }) as never;

function harness(overrides: Partial<ReviveDeps> = {}) {
  const calls: string[] = [];
  const runs: unknown[] = [];
  const deps: ReviveDeps = {
    getProject: () => project,
    readState: () => idleState,
    readLaunches: () => ({ ios: iosLaunch }),
    liveSupervisor: () => null,
    resolveIos: async () => sim('Shutdown'),
    resolveAndroid: async () => ({ notRunning: true }),
    appRunning: async () => true,
    artifactExists: () => true,
    startMetro: async () => {
      calls.push('metro');
      return { ok: true };
    },
    run: async (platform, _root, request) => {
      calls.push(platform);
      runs.push(request);
      return { ok: true, deviceId: 'U1', deviceName: 'stim-app', launched: true };
    },
    ...overrides,
  };
  return { deps, calls, runs };
}

test('an idle-stopped workspace gets Metro, its simulator and its last app back, from the installed artifact', async () => {
  const { deps, calls, runs } = harness({
    readLaunches: () => ({
      ios: iosLaunch,
      'android:release': { ...iosLaunch, appId: 'com.example.release', release: true, metroPort: null },
    }),
  });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(result.ok);
  expect(calls).toEqual(['metro', 'ios']);
  expect(runs).toEqual([
    {
      slot: 'default',
      configuration: 'Debug',
      recordedBuild: {
        appPath: APP,
        bundleId: 'com.example.app',
        builtAt: '',
        cache: { fingerprint: 'f1', key: 'f1-debug-sim-arm64', hit: 'local' },
      },
    },
  ]);
  expect(result.facts.revived).toEqual({
    metro: { port: 8082, stoppedAt: '2026-11-01T10:30:00.000Z', reason: 'idle', restarted: true },
    devices: [
      {
        platform: 'ios',
        slot: 'default',
        deviceId: 'U1',
        deviceName: 'stim-app',
        rebooted: true,
        app: { bundleId: 'com.example.app', relaunched: true, launched: true },
      },
    ],
  });
  expect(reviveLines(result.facts, Date.parse('2026-11-02T00:32:00.000Z'))).toEqual([
    'Metro stopped idle 14h02m ago, restarted on port 8082.',
    'Simulator stim-app rebooted.',
    'com.example.app relaunched from cold on Simulator stim-app; in-app state is gone.',
  ]);
});

test.each([
  ['was never started', {}],
  [
    'was stopped on purpose',
    { devServerStop: { reason: 'requested', at: '2026-11-01T10:30:00.000Z', by: 'stim stop', byPid: 7 } },
  ],
])('a workspace whose Metro %s refuses with STIM_NO_METRO and starts nothing', async (_name, state) => {
  const { deps, calls } = harness({ readState: () => state });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_NO_METRO');
  expect(calls).toEqual([]);
});

test.each<[string, Partial<ReviveDeps>]>([
  [
    'the slot now records another simulator',
    { getProject: () => ({ ...project, platforms: { ios: { deviceUdid: 'U2', owned: true } } }) },
  ],
  ['the simulator was deleted', { resolveIos: async () => ({ missing: true }) }],
  [
    'the emulator is no longer Stim-owned',
    {
      getProject: () => ({ ...project, platforms: { android: { avdName: 'stim-app', owned: true } } }),
      readLaunches: () => ({ android: { ...iosLaunch, deviceId: 'emulator-5554' } }),
      resolveAndroid: async () => ({ notOwned: true }),
    },
  ],
])('refuses with STIM_DEVICE_LOST before starting anything when %s', async (_name, overrides) => {
  const { deps, calls } = harness(overrides);
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_DEVICE_LOST');
  expect(calls).toEqual([]);
});

test('refuses with STIM_NO_RECORDED_BUILD naming the platform command when the installed artifact is gone', async () => {
  const { deps, calls } = harness({
    artifactExists: () => false,
    readLaunches: () => ({ 'ios:tablet': iosLaunch }),
    getProject: () => ({ ...project, deviceSlots: { tablet: project.platforms! } }),
  });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_NO_RECORDED_BUILD');
  expect(result.error.remedy).toContain('`stim ios --slot tablet`');
  expect(calls).toEqual([]);
});

test('with Metro running, revive boots a shut-down device and leaves a running app alone', async () => {
  const live = { pid: 1, port: 8082, mode: 'expo', startedAt: null };
  const shutDown = harness({ liveSupervisor: () => live, readState: () => ({ lastIosBuild: idleState.lastIosBuild }) });
  const rebooted = await runRevive({ root: '/project', note: () => {}, deps: shutDown.deps });
  assert(rebooted.ok);
  expect(shutDown.calls).toEqual(['ios']);
  expect(rebooted.facts.revived.metro).toEqual({ port: 8082, stoppedAt: null, reason: null, restarted: false });

  const running = harness({ liveSupervisor: () => live, resolveIos: async () => sim('Booted') });
  const untouched = await runRevive({ root: '/project', note: () => {}, deps: running.deps });
  assert(untouched.ok);
  expect(running.calls).toEqual([]);
  expect(untouched.facts.revived.devices[0]).toMatchObject({ rebooted: false, app: { relaunched: false } });
  expect(reviveLines(untouched.facts, 0).at(-1)).toBe('Nothing to revive.');
});
