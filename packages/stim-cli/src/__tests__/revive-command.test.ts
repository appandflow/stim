import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import type { WorkspaceState } from '@stim-cli/core/state';
import { resolveBuild } from '../cache/build-cache.ts';
import { registerRevive, reviveLines, runRevive, type ReviveDeps } from '../commands/revive.ts';
import type { WorkspaceLaunchRecord } from '../stimd/metro/state.ts';
import type { ProjectRecord } from '../workspace/config.ts';

const CACHED = '/stim/build-cache/ios/f1-debug-sim-arm64/App.app';

const iosLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.app',
  deviceId: 'U1',
  metroPort: 8082,
  release: false,
  launchedAt: '2026-11-01T10:00:00.000Z',
  artifact: {
    configuration: 'Debug',
    fingerprint: 'f1',
    cacheKey: 'f1-debug-sim-arm64',
    cacheHit: false,
  },
};

const project: ProjectRecord = {
  metroPort: 8082,
  platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
};

const idleState: WorkspaceState = {
  devServerStop: { reason: 'idle', at: '2026-11-01T10:30:00.000Z', idleMinutes: 15 },
};

const sim = (state: string) => ({ sim: { udid: 'U1', name: 'stim-app', state } }) as never;

function harness(overrides: Partial<ReviveDeps> = {}) {
  const calls: string[] = [];
  const runs: unknown[] = [];
  const deps: ReviveDeps = {
    findWorkspace: async () => '/project',
    getProject: () => project,
    readState: () => idleState,
    readLaunches: () => ({ ios: iosLaunch }),
    liveSupervisor: () => null,
    resolveIos: async () => sim('Shutdown'),
    resolveAndroid: async () => ({ notRunning: true }),
    appRunning: async () => true,
    resolveCachedApp: (_platform, key) => (key === 'f1-debug-sim-arm64' ? CACHED : null),
    startMetro: async () => {
      calls.push('metro');
      return { ok: true, port: 8082 };
    },
    run: async (platform, _root, request) => {
      calls.push(platform);
      runs.push(request);
      return { ok: true, deviceId: 'U1', deviceName: 'stim-app', launched: true };
    },
    detectProject: async () => ({ platforms: ['ios', 'android'], devServer: true }),
    ...overrides,
  };
  return { deps, calls, runs };
}

test('an idle-stopped workspace gets Metro, its simulator and the app it launched back, from the installed artifact', async () => {
  const { deps, calls, runs } = harness({
    readLaunches: () => ({
      ios: iosLaunch,
      'android:release': { ...iosLaunch, appId: 'com.example.release', release: true, metroPort: null },
    }),
  });
  const result = await runRevive({ root: '/project', note: () => {}, requestedDevice: 'U1', deps });
  assert(result.ok);
  expect(calls).toEqual(['metro', 'ios']);
  expect(runs).toEqual([
    {
      slot: 'default',
      configuration: 'Debug',
      recordedBuild: {
        appPath: CACHED,
        bundleId: 'com.example.app',
        builtAt: '',
        cache: { fingerprint: 'f1', key: 'f1-debug-sim-arm64', hit: 'local' },
      },
      installedApp: null,
      expectedDevice: 'U1',
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

test('a later build does not change what revive installs, and an evicted cache entry refuses', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'stim-test-'));
  try {
    mkdirSync(join(cache, 'ios', 'f1-debug-sim-arm64', 'App.app'), { recursive: true });
    mkdirSync(join(cache, 'ios', 'f2-debug-sim-arm64', 'App.app'), { recursive: true });
    const fromCache = (_platform: string, key: string) => resolveBuild('ios', key, cache);
    const recorded = harness({ resolveCachedApp: fromCache });
    const revived = await runRevive({ root: '/project', note: () => {}, deps: recorded.deps });
    assert(revived.ok);
    expect(recorded.runs).toMatchObject([
      { recordedBuild: { appPath: join(cache, 'ios', 'f1-debug-sim-arm64', 'App.app') } },
    ]);

    rmSync(join(cache, 'ios', 'f1-debug-sim-arm64'), { recursive: true });
    const evicted = harness({ resolveCachedApp: fromCache });
    const refused = await runRevive({ root: '/project', note: () => {}, deps: evicted.deps });
    assert(!refused.ok);
    expect(refused.error.code).toBe('STIM_NO_RECORDED_BUILD');
    expect(evicted.calls).toEqual([]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test.each<[string, Partial<ReviveDeps>]>([
  ['was never started', { readState: () => ({}) }],
  [
    'was stopped on purpose',
    {
      readState: () => ({
        devServerStop: { reason: 'requested', at: '2026-11-01T10:30:00.000Z', by: 'stim stop', byPid: 7 },
      }),
    },
  ],
  ['was stopped idle, then stim stop released its port', { getProject: () => ({ ...project, metroPort: null }) }],
])('a workspace whose Metro %s refuses with STIM_NO_METRO and starts nothing', async (_name, overrides) => {
  const { deps, calls } = harness(overrides);
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_NO_METRO');
  expect(calls).toEqual([]);
});

test.each<[string, Partial<ReviveDeps>, string | null]>([
  [
    'the slot now records another simulator',
    { getProject: () => ({ ...project, platforms: { ios: { deviceUdid: 'U2', owned: true } } }) },
    null,
  ],
  ['the simulator was deleted', { resolveIos: async () => ({ missing: true }) }, null],
  [
    'the emulator is no longer Stim-owned',
    {
      getProject: () => ({ ...project, platforms: { android: { avdName: 'stim-app', owned: true } } }),
      readLaunches: () => ({ android: { ...iosLaunch, deviceId: 'emulator-5554', avdName: 'stim-app' } }),
      resolveAndroid: async () => ({ notOwned: true }),
    },
    null,
  ],
  [
    'the slot adopted another emulator since the launch',
    {
      getProject: () => ({ ...project, platforms: { android: { avdName: 'stim-parked', owned: true } } }),
      readLaunches: () => ({ android: { ...iosLaunch, deviceId: 'emulator-5554', avdName: 'stim-app' } }),
    },
    null,
  ],
  ['agent-device asks for a device the workspace did not launch on', {}, 'OTHER-SIM'],
])('refuses with STIM_DEVICE_LOST before starting anything when %s', async (_name, overrides, requestedDevice) => {
  const { deps, calls } = harness(overrides);
  const result = await runRevive({ root: '/project', note: () => {}, requestedDevice, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_DEVICE_LOST');
  expect(calls).toEqual([]);
});

test.each<[string, string, Partial<ReviveDeps>, string]>([
  [
    'a Release build as its last launch',
    'U1',
    { readLaunches: () => ({ ios: { ...iosLaunch, release: true, metroPort: null } }) },
    '`stim ios`',
  ],
  [
    'a native-process launch as its last launch',
    'stim-avd',
    {
      readLaunches: () => ({
        android: { ...iosLaunch, deviceId: 'emulator-5554', avdName: 'stim-avd', runtime: 'process', metroPort: null },
      }),
    },
    '`stim android`',
  ],
  [
    'an emulator launch an older Stim recorded without its AVD name',
    'stim-avd',
    { readLaunches: () => ({ android: { ...iosLaunch, deviceId: 'emulator-5554', artifact: undefined } }) },
    '`stim android`',
  ],
  [
    'no launch recorded on its slot',
    'stim-avd',
    { getProject: () => ({ ...project, deviceSlots: { tablet: { android: { avdName: 'stim-avd', owned: true } } } }) },
    '`stim android --slot tablet`',
  ],
])(
  "run as agent-device's boot hook for its own device with %s, revive refuses with that slot's command",
  async (_name, requestedDevice, overrides, command) => {
    const { deps, calls } = harness({
      getProject: () => ({
        ...project,
        platforms: { ...project.platforms, android: { avdName: 'stim-avd', owned: true } },
      }),
      ...overrides,
    });
    const result = await runRevive({ root: '/project', note: () => {}, requestedDevice, deps });
    assert(!result.ok);
    expect(result.error.code).toBe('STIM_NO_RECORDED_BUILD');
    expect(result.error.remedy).toContain(command);
    expect(calls).toEqual([]);
  },
);

test.each<[string, string, Partial<ReviveDeps>, string]>([
  ['the simulator UDID', 'U1', { resolveAndroid: async () => ({ missing: true }) }, 'ios'],
  ["the stopped emulator's AVD name", 'stim-avd', { resolveIos: async () => ({ missing: true }) }, 'android'],
])(
  "run as agent-device's boot hook for %s, revive restores only that launch",
  async (_name, requestedDevice, overrides, revived) => {
    const { deps, calls } = harness({
      getProject: () => ({
        ...project,
        platforms: { ...project.platforms, android: { avdName: 'stim-avd', owned: true } },
      }),
      readLaunches: () => ({
        ios: iosLaunch,
        android: { ...iosLaunch, deviceId: 'emulator-5554', avdName: 'stim-avd' },
      }),
      ...overrides,
    });
    const result = await runRevive({ root: '/project', note: () => {}, requestedDevice, deps });
    assert(result.ok);
    expect(calls).toEqual(['metro', revived]);
  },
);

test.each<[string, Partial<ReviveDeps>, string]>([
  ['the cache entry the launch installed is gone', { resolveCachedApp: () => null }, 'stim ios --slot tablet'],
  [
    'the launch installed an app that was never cached',
    {
      readLaunches: () => ({
        'ios:tablet': { ...iosLaunch, artifact: { ...iosLaunch.artifact!, fingerprint: null, cacheKey: null } },
      }),
    },
    'stim ios --slot tablet',
  ],
  [
    'the launch records no installed app',
    { readLaunches: () => ({ 'ios:tablet': { ...iosLaunch, artifact: undefined } }) },
    'stim ios --slot tablet',
  ],
  [
    'an older Stim recorded the emulator launch without its AVD or app',
    { readLaunches: () => ({ 'android:tablet': { ...iosLaunch, deviceId: 'emulator-5554', artifact: undefined } }) },
    'stim android --slot tablet',
  ],
])('refuses with STIM_NO_RECORDED_BUILD naming the platform command when %s', async (_name, overrides, command) => {
  const { deps, calls } = harness({
    readLaunches: () => ({ 'ios:tablet': iosLaunch }),
    getProject: () => ({ ...project, deviceSlots: { tablet: project.platforms! } }),
    ...overrides,
  });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe('STIM_NO_RECORDED_BUILD');
  expect(result.error.remedy).toContain(`\`${command}\``);
  expect(calls).toEqual([]);
});

const exactLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.exact',
  deviceId: 'U1',
  metroPort: null,
  release: false,
  runtime: 'process',
  launchedAt: '2026-11-01T10:00:00.000Z',
  artifact: { configuration: 'Debug', fingerprint: null, cacheKey: null, cacheHit: false },
};

const exactDeps: Partial<ReviveDeps> = {
  getProject: () => ({ ...project, metroPort: null }),
  readState: () => ({ deviceIdleShutdowns: { ios: { at: '2026-11-01T10:30:00.000Z', idleMinutes: 15 } } }),
  readLaunches: () => ({ ios: exactLaunch }),
  detectProject: async () => ({ platforms: ['ios'], devServer: false }),
};

test.each<[string, string | null]>([
  ['run by hand', null],
  ["run as agent-device's boot hook", 'U1'],
])(
  'a native-process launch whose simulator was shut down comes back from its installed app without Metro, %s',
  async (_name, requestedDevice) => {
    const { deps, calls, runs } = harness(exactDeps);
    const result = await runRevive({ root: '/project', note: () => {}, requestedDevice, deps });
    assert(result.ok);
    expect(calls).toEqual(['ios']);
    expect(runs).toEqual([
      {
        slot: 'default',
        configuration: 'Debug',
        recordedBuild: null,
        installedApp: 'com.example.exact',
        expectedDevice: 'U1',
      },
    ]);
    expect(result.facts.revived.metro).toEqual({ port: null, stoppedAt: null, reason: null, restarted: false });
    expect(reviveLines(result.facts, 0)).toEqual([
      'Simulator stim-app rebooted.',
      'com.example.exact relaunched from cold on Simulator stim-app; in-app state is gone.',
    ]);
  },
);

test('a native-process app still running on its booted simulator is left as is', async () => {
  const { deps, calls } = harness({ ...exactDeps, resolveIos: async () => sim('Booted') });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(result.ok);
  expect(calls).toEqual([]);
  expect(reviveLines(result.facts, 0)).toEqual([
    'com.example.exact is running on Simulator stim-app; left as is.',
    'Nothing to revive.',
  ]);
});

test.each<[string, Partial<ReviveDeps>, string]>([
  [
    'an app without Metro was stopped, which clears its launches',
    { ...exactDeps, readLaunches: () => ({}) },
    'STIM_NO_METRO',
  ],
  ['an app without Metro was never registered', { ...exactDeps, getProject: () => null }, 'STIM_NO_PROJECT'],
  [
    'the last launch was a Release build and Metro was stopped',
    {
      readState: () => ({}),
      readLaunches: () => ({ ios: { ...iosLaunch, release: true, metroPort: null } }),
    },
    'STIM_NO_METRO',
  ],
])('when %s, the refusal names stim ios, never stim start', async (_name, overrides, code) => {
  const { deps, calls } = harness(overrides);
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(!result.ok);
  expect(result.error.code).toBe(code);
  expect(result.error.remedy).toContain('`stim ios`');
  expect(result.error.remedy).not.toContain('stim start');
  expect(calls).toEqual([]);
});

test('a slot placed on a hosting Mac is left to its host', async () => {
  const { deps, calls } = harness({
    readState: () => ({ ...idleState, ios: { host: { machine: 'studio' } } }),
    resolveIos: async () => ({ missing: true }),
  });
  const result = await runRevive({ root: '/project', note: () => {}, deps });
  assert(result.ok);
  expect(calls).toEqual(['metro']);
  expect(result.facts.revived.devices).toEqual([]);
});

test('with Metro running, revive boots a shut-down device and leaves a running app alone', async () => {
  const live = { pid: 1, port: 8082, mode: 'expo', startedAt: null };
  const shutDown = harness({ liveSupervisor: () => live, readState: () => ({}) });
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

describe('the command output', () => {
  let home: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = home;
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line) => void err.push(String(line)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  async function revive(args: string[], overrides: Partial<ReviveDeps>) {
    const program = new Command().exitOverride();
    const { deps } = harness({ findWorkspace: async () => join(home, 'app'), ...overrides });
    registerRevive(program, deps);
    await program.parseAsync(['node', 'stim', 'revive', ...args]);
  }

  test.each<[string, Partial<ReviveDeps>, number | undefined]>([
    ['the revived facts', {}, undefined],
    ['the refusal', { readState: () => ({}) }, 1],
  ])(
    '--json prints exactly one parseable line with %s, and the human lines on stderr',
    async (_name, overrides, code) => {
      await revive(['--json'], overrides);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toHaveProperty(code ? 'code' : 'revived');
      expect(err.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(code);
    },
  );

  test('plain output leaves stdout empty', async () => {
    await revive([], {});
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('in-app state is gone');
  });
});
