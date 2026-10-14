import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { enforceBudget } from '../budget.ts';
import { collectIdleDevicesAsync } from '../commands/gc/idle.ts';
import { createActivityReader, createActivityReaderAsync } from '../devices/activity.ts';
import { ownedAvdSerialResolverAsync } from '../devices/android.ts';
import { createIosSimSnapshot } from '../devices/ios.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { loadConfig, upsertProject } from '../workspace/config.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

let base: string;
let project: string;
const NOW = Date.parse('2026-10-14T06:00:00Z');
const SIMS = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      {
        udid: 'S1',
        name: 'stim-fixture',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
    ],
  },
});

beforeEach(() => {
  resetExecutor();
  base = mkdtempSync(join(tmpdir(), 'stim-budget-probes-'));
  process.env.STIM_HOME = join(base, 'home');
  project = join(base, 'project');
  mkdirSync(project);
  upsertProject(project, {
    isExpo: false,
    platforms: { ios: { owned: true, deviceUdid: 'S1' }, android: { owned: true, avdName: 'stim-a' } },
    deviceSlots: { second: { android: { owned: true, avdName: 'stim-b' } } },
  });
  recordWorkspaceUse(project, new Date(NOW - 3_600_000));
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

async function responsive<T>(read: () => Promise<T>): Promise<T> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await read();
    expect(ticks).toBeGreaterThan(0);
    return result;
  } finally {
    clearInterval(timer);
  }
}

function delayedTools({ wedgedFirst = false, failedHost = false, failedInstrumentation = false, driver = false } = {}) {
  const real = getExecutor();
  const calls: string[] = [];
  let inventories = 0;
  const childArgs = (file: string, args: string[]) => {
    const tool = basename(file).replace(/\.exe$/, '');
    calls.push([tool, ...args].join(' '));
    let output: string;
    let failed = false;
    if (tool === 'xcrun') output = SIMS;
    else if (tool === 'emulator') output = !wedgedFirst || ++inventories === 1 ? 'stim-a\nstim-b\nuser-avd\n' : '';
    else if (tool === 'ps') {
      failed = failedHost;
      output = driver
        ? '123 1 2048 0.0 Thu Sep 24 22:00:05 2026 xcodebuild test-without-building -destination platform=iOS Simulator,id=S1\n'
        : 'PID PPID RSS CPU START COMMAND\n';
    } else if (args[0] === 'devices') {
      output = 'List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n';
    } else if (args.includes('shell')) {
      failed = failedInstrumentation;
      output = 'PID ARGS\n';
    } else {
      failed = wedgedFirst && args[1] === 'emulator-5554';
      output = args[1] === 'emulator-5554' ? 'stim-a\nOK\n' : 'stim-b\nOK\n';
    }
    return [
      '-e',
      `setTimeout(() => { process.stdout.write(${JSON.stringify(output)}); process.exit(${failed ? 1 : 0}); }, 60)`,
    ];
  };
  const executor = {
    ...real,
    runFile: (file: string, args: string[], options: Parameters<typeof real.runFile>[2]) =>
      real.runFile(process.execPath, childArgs(file, args), options),
    runFileAsync: (file: string, args: string[], options: Parameters<typeof real.runFileAsync>[2]) =>
      real.runFileAsync(process.execPath, childArgs(file, args), options),
    runFileQuiet: (file: string, args: string[], options: Parameters<typeof real.runFileQuiet>[2]) =>
      real.runFileQuiet(process.execPath, childArgs(file, args), options),
    runFileQuietAsync: (file: string, args: string[], options: Parameters<typeof real.runFileQuietAsync>[2]) =>
      real.runFileQuietAsync(process.execPath, childArgs(file, args), options),
  };
  return { executor, calls };
}

test('budget measurements yield and retain all owned slots and idle-preview targets', async () => {
  const { executor } = delayedTools();
  setExecutor(executor);
  const outcome = await responsive(() =>
    enforceBudget({
      root: join(base, 'current'),
      note: () => {},
      dryRun: true,
      env: { HOME: join(base, 'private-user') },
      budget: { minFreeDiskMb: 0, hardFloorDiskMb: 0, maxCommittedMemoryMb: 1, maxLiveWorkspaces: 0 },
    }),
  );
  expect(outcome).toMatchObject({ status: 'ok', measure: { memory: { committedMb: 6500, liveWorkspaces: 1 } } });
  assert(outcome.status === 'ok');
  expect(outcome.reclaimed.find((entry) => entry.step === 'idle-devices')?.targets).toEqual([
    `ios stim-fixture in ${project}`,
    `android stim-a in ${project}`,
    `android stim-b in ${project}`,
  ]);
});

test('one async resolver retains its inventory and does not retry a wedged emulator for every AVD', async () => {
  const { executor, calls } = delayedTools({ wedgedFirst: true });
  setExecutor(executor);
  const resolve = ownedAvdSerialResolverAsync({ timeoutMs: 5000 });
  const results = await responsive(async () => [await resolve('stim-a'), await resolve('stim-b')]);
  expect(results).toEqual([{ notRunning: true }, { serial: 'emulator-5556' }]);
  expect(await resolve('user-avd')).toEqual({ notOwned: true });
  expect(await resolve('absent')).toEqual({ missing: true });
  expect(calls.filter((call) => call.includes('-list-avds'))).toHaveLength(1);
  expect(calls.filter((call) => call.includes('emulator-5554'))).toHaveLength(1);
});

test.each([false, true])('activity reads yield and preserve driver classification (driver: %s)', async (driver) => {
  const { executor, calls } = delayedTools({ driver });
  setExecutor(executor);
  const options = { home: join(base, 'private-user'), now: NOW, leaseFiles: () => [], viewers: () => [] };
  const target = { platform: 'ios' as const, id: 'S1', slot: 'default', workspace: project };
  const expected = createActivityReader(options)(target);
  calls.length = 0;
  const read = createActivityReaderAsync(options);
  const observed = await responsive(() => read(target));
  expect(observed).toEqual(expected);
  expect(observed.state).toBe(driver ? 'driven' : 'idle');
  await read({ ...target, id: 'S2' });
  expect(calls.filter((call) => call.startsWith('ps '))).toHaveLength(1);
});

test.each(['host', 'instrumentation'])(
  'failed %s observation never makes an owned device eligible for idle reclaim',
  async (failure) => {
    const { executor } = delayedTools({
      failedHost: failure === 'host',
      failedInstrumentation: failure === 'instrumentation',
    });
    setExecutor(executor);
    const devices = await responsive(() =>
      collectIdleDevicesAsync(loadConfig(), [], [], NOW, { HOME: join(base, 'private-user') }),
    );
    expect(devices).toEqual([]);
  },
);

test('async simulator snapshot shares its result with sync consumers and drops an in-flight listing on invalidation', async () => {
  const snapshot = createIosSimSnapshot();
  assert(snapshot.readAsync);
  const resolves: ((value: string) => void)[] = [];
  const real = getExecutor();
  setExecutor({ ...real, runFileAsync: () => new Promise<string>((resolve) => resolves.push(resolve)) });
  const first = snapshot.readAsync();
  snapshot.invalidate();
  const second = snapshot.readAsync();
  resolves[0]?.(SIMS);
  await first;
  resolves[1]?.(JSON.stringify({ devices: {} }));
  expect(await second).toEqual([]);
  expect(snapshot.read()).toEqual([]);
  expect(resolves).toHaveLength(2);
});

test.each([false, true])(
  'an iOS-only budget measurement yields for its simulator listing (snapshot: %s)',
  async (shared) => {
    upsertProject(project, { platforms: { ios: { owned: true, deviceUdid: 'S1' } }, deviceSlots: {} });
    const { executor } = delayedTools();
    setExecutor(executor);
    const snapshot = shared ? createIosSimSnapshot() : undefined;
    const outcome = await responsive(() =>
      enforceBudget({
        root: project,
        note: () => {},
        simSnapshot: snapshot,
        budget: { minFreeDiskMb: 0, hardFloorDiskMb: 0, maxCommittedMemoryMb: 100000, maxLiveWorkspaces: 0 },
      }),
    );
    expect(outcome).toMatchObject({
      status: 'ok',
      measure: { memory: { committedMb: 1500, liveWorkspaces: 1 } },
      reclaimed: [],
    });
  },
);

test('a failed simulator snapshot read can retry instead of permanently caching the refusal', async () => {
  const snapshot = createIosSimSnapshot();
  assert(snapshot.readAsync);
  const real = getExecutor();
  let calls = 0;
  setExecutor({
    ...real,
    runFileAsync: async () => {
      if (++calls === 1) throw new Error('listing failed');
      return SIMS;
    },
  });
  await expect(snapshot.readAsync()).rejects.toThrow('listing failed');
  expect((await snapshot.readAsync()).map((sim) => sim.udid)).toEqual(['S1']);
});
