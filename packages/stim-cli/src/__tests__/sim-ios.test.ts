import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import {
  parseSimctlList,
  pickDefaultIosCreation,
  deleteIosSim,
  bootIosSim,
  clearIosAppData,
  parseUserApps,
} from '../devices/ios.ts';
import assert from 'node:assert';
import { makeChildProcess, makeExitingChild } from './_factories.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  for (const udid of ['IOS-1', 'TV-1', 'U1', 'UDID-A', 'UDID-B', 'UDID-C', 'UDID-OLD', 'UDID-X', 'VISION-1', 'WATCH-1'])
    recordCreatedDevice('ios', udid);
  for (const name of [
    'stim-app',
    'stim-app-tablet',
    'stim-desktop',
    'stim-feat-a-tlon-mobile',
    'stim-my-project',
    'stim-old',
    'stim-test-dialogue',
    'stim-wt',
    'stim-x',
  ])
    recordCreatedDevice('android', name);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  resetExecutor();
});

JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      {
        udid: 'UDID-A',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15',
      },
      {
        udid: 'UDID-B',
        name: 'iPhone 15 Pro',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15-pro',
      },
      {
        udid: 'UDID-C',
        name: 'iPhone 14',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-14',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      {
        udid: 'UDID-OLD',
        name: 'iPhone 13',
        state: 'Shutdown',
        isAvailable: false,
        deviceTypeIdentifier: 'iphone-13',
      },
    ],
  },
});

test('parseSimctlList rejects structurally invalid successful output', () => {
  for (const output of ['[]', '{}', '"ok"', '{"devices":[]}']) {
    expect(() => parseSimctlList(output)).toThrow(/devices object/);
  }
  expect(() => parseSimctlList('{"devices":{"ios":{}}}')).toThrow(/to be an array/);
});

test('parseSimctlList rejects incomplete or mistyped iOS device records', () => {
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
  const valid = {
    udid: 'U1',
    name: 'stim-app',
    state: 'Shutdown',
    isAvailable: true,
    deviceTypeIdentifier: 'iphone-17',
  };
  for (const bad of [
    { ...valid, udid: undefined },
    { ...valid, name: 42 },
    { ...valid, state: '' },
    { ...valid, deviceTypeIdentifier: null },
    { ...valid, isAvailable: undefined },
    { ...valid, isAvailable: 'yes' },
    { ...valid, dataPath: 42 },
    { ...valid, dataPathSize: Number.NaN },
  ]) {
    expect(() =>
      parseSimctlList(JSON.stringify({ devices: { [runtime]: [bad] } }), { includeUnavailable: true }),
    ).toThrow(/Expected simctl device field/);
  }
  expect(() => parseSimctlList(JSON.stringify({ devices: { [runtime]: ['corrupt'] } }))).toThrow(/every simctl device/);
});

test('pickDefaultIosCreation honors explicit deviceType and runtime by name', () => {
  const deviceTypes = [{ identifier: 'dt.iphone16', name: 'iPhone 16' }];
  const runtimes = [
    { identifier: 'rt.26-2', name: 'iOS 26.2', version: '26.2', supportedDeviceTypes: deviceTypes },
    { identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 16', runtime: '26.2' });
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.iphone16');
  expect(pick.runtimeId).toBe('rt.26-2');
});

test('pickDefaultIosCreation skips a newer runtime whose only iPhone is a special model (#1172)', () => {
  const duo = [{ identifier: 'dt.duo', name: 'iPhone Duo' }];
  const gen18Pro = [{ identifier: 'dt.18pro', name: 'iPhone 18 Pro' }];
  const gen16Pro = [{ identifier: 'dt.16pro', name: 'iPhone 16 Pro' }];
  const runtimes = [
    { identifier: 'rt.27-1', name: 'iOS 27.1', version: '27.1', supportedDeviceTypes: duo },
    { identifier: 'rt.27-0', name: 'iOS 27.0', version: '27.0', supportedDeviceTypes: gen18Pro },
    { identifier: 'rt.18-6', name: 'iOS 18.6', version: '18.6', supportedDeviceTypes: gen16Pro },
  ];
  const pick = pickDefaultIosCreation([], runtimes, {});
  assert(pick);
  expect(pick.runtimeId).toBe('rt.27-0');
  expect(pick.deviceTypeId).toBe('dt.18pro');
});

test('deleteIosSim refuses to delete a sim not owned by Stim', async () => {
  setExecutor({
    runFile: () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
            {
              udid: 'UDID-A',
              name: 'iPhone 15',
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone-15',
            },
          ],
        },
      }),
    runQuiet: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  await expect(deleteIosSim('UDID-A')).rejects.toThrow(/Stim/);
});

const OWNED_SIM_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      {
        udid: 'UDID-B',
        name: 'stim-my-project',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15',
      },
    ],
  },
});

OWNED_SIM_LIST.replace('"Shutdown"', '"Booted"');

test('parseUserApps keeps only user applications', async () => {
  expect(
    parseUserApps(
      JSON.stringify({
        'com.example.one': { ApplicationType: 'User' },
        'com.apple.Preferences': { ApplicationType: 'System' },
        'com.example.two': { ApplicationType: 'User' },
      }),
    ),
  ).toEqual(['com.example.one', 'com.example.two']);
  expect(() => parseUserApps('not json')).toThrow(/JSON/);
  expect(() => parseUserApps('[]')).toThrow(/JSON object/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': 'corrupt' }))).toThrow(/to be an object/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': {} }))).toThrow(/known ApplicationType/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': { ApplicationType: 'Unknown' } }))).toThrow(
    /known ApplicationType/,
  );
});

describe('clearIosAppData', () => {
  let container: string;
  beforeEach(() => {
    container = mkdtempSync(join(tmpdir(), 'stim-app-data-'));
    for (const dir of ['Documents', 'Library/Preferences', 'tmp', 'SystemData']) {
      mkdirSync(join(container, dir), { recursive: true });
    }
    writeFileSync(join(container, 'Documents', 'db.sqlite'), 'rows');
    writeFileSync(join(container, 'Library', 'Preferences', 'com.example.app.plist'), 'prefs');
    writeFileSync(join(container, 'tmp', 'scratch'), 'tmp');
    writeFileSync(join(container, '.com.apple.mobile_container_manager.metadata.plist'), 'metadata');
  });
  afterEach(() => rmSync(container, { recursive: true, force: true }));

  function exec(
    deleteError: string | null,
    inputs: Array<string | undefined> = [],
    terminateError = 'found nothing to terminate',
  ) {
    const calls: string[][] = [];
    setExecutor({
      run: () => {
        throw new Error('must not invoke a shell');
      },
      runFile(file, args = [], options) {
        calls.push([file, ...args]);
        inputs.push(options?.input);
        if (args[1] === 'terminate' && terminateError) throw new Error(`Command failed\n${terminateError}`);
        if (args.includes('defaults') && deleteError) throw new Error(`Command failed\n${deleteError}`);
        if (args[1] === 'get_app_container') return `${container}\n`;
        return '';
      },
      runQuiet: () => null,
      spawn: () => null,
    });
    return calls;
  }

  test('removes a symlinked data directory without touching its target', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-app-group-'));
    try {
      writeFileSync(join(outside, 'shared.db'), 'group data');
      rmSync(join(container, 'Documents'), { recursive: true });
      symlinkSync(outside, join(container, 'Documents'));
      exec(null);
      await clearIosAppData('U1', 'com.example.app');
      expect(readdirSync(outside)).toEqual(['shared.db']);
      expect(readdirSync(container)).not.toContain('Documents');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function bootSimList(state: string) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        { udid: 'UDID-A', name: 'stim-app', state, isAvailable: true, deviceTypeIdentifier: 'iphone-15' },
      ],
    },
  });
}

type BootstatusOutcome = 'hang' | { exitCode: number; stderr?: string };

function bootstatusExecutor(outcomes: BootstatusOutcome[], list: () => string) {
  const spawned: string[] = [];
  const quiet: string[] = [];
  const omittedEnv: (readonly string[] | undefined)[] = [];
  setExecutor({
    runFile: (_file, args = []) => {
      if (args.includes('devices')) return list();
      return '';
    },
    runFileQuiet: (file, args = [], opts) => {
      quiet.push([file, ...args].join(' '));
      omittedEnv.push(opts?.omitEnv);
      return '';
    },
    spawn: (cmd: string, args: readonly string[] = []) => {
      if (args[1] === 'boot') return makeExitingChild();
      spawned.push([cmd, ...args].join(' '));
      const outcome = outcomes[spawned.length - 1] ?? outcomes[outcomes.length - 1] ?? 'hang';
      if (outcome === 'hang') {
        const child = makeChildProcess();
        child.kill = () => {
          queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
          return true;
        };
        return child;
      }
      return makeExitingChild(outcome.exitCode, outcome.stderr);
    },
  });
  return { spawned, quiet, omittedEnv };
}

test.each(['Booting', 'Booted'])(
  'bootIosSim names the udid and the wait when the deadline expires while %s',
  async (state) => {
    bootstatusExecutor(['hang'], () => bootSimList(state));
    await expect(bootIosSim('UDID-A', { timeoutMs: 1200, attemptMs: 300 })).rejects.toThrow(
      /UDID-A did not finish booting within 1s/,
    );
  },
);

async function bootWaitingForSpringBoard(startsAfterMs: number) {
  vi.useFakeTimers();
  const messages: string[] = [];
  const started = Date.now();
  setExecutor({
    runFile: (_file, args = []) => {
      if (args.includes('notifyutil')) {
        return `com.apple.springboard.finishedstartup ${Date.now() - started >= startsAfterMs ? 4242 : 0}\n`;
      }
      return args[0] === '-n' ? '1' : bootSimList('Booted');
    },
    runFileQuiet: () => '',
    spawn: () => makeExitingChild(),
  });
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  let settled = false;
  const outcome = bootIosSim('UDID-A', { timeoutMs: 60000, out: (message) => messages.push(message) })
    .catch((error: Error) => error)
    .finally(() => (settled = true));
  await vi.advanceTimersByTimeAsync(44000);
  const settledEarly = settled;
  await vi.advanceTimersByTimeAsync(17000);
  return { settledEarly, result: await outcome, messages };
}

test('bootIosSim fails at the boot deadline when SpringBoard never starts', async () => {
  try {
    const { result } = await bootWaitingForSpringBoard(Infinity);
    expect((result as Error).message).toMatch(
      /UDID-A did not finish booting within 60s\. Last boot output: waiting for SpringBoard/,
    );
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

test('bootstatus refuses a retry when termination cannot be confirmed within the cleanup bound', async () => {
  vi.useFakeTimers();
  let surveys = 0;
  setExecutor({
    runFile(_file, args = []) {
      if (args[1] === 'list') surveys++;
      return '';
    },
    spawn: (_cmd, args) => (args[1] === 'boot' ? makeExitingChild() : makeChildProcess()),
  });
  try {
    const outcome = bootIosSim('UDID-A', { attemptMs: 100 }).then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(10100);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/could not be confirmed stopped/) });
    expect(surveys).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('boot diagnostics retain peak pressure after recovery and unknown readings, then stop sampling', async () => {
  vi.useFakeTimers();
  const messages: string[] = [];
  let reads = 0;
  const levels = ['1', '2', '', '1'];
  const child = makeChildProcess();
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  setExecutor({
    runFile: (_file, args) =>
      args[0] === '-n' ? levels[Math.min(reads++, levels.length - 1)] : bootSimList('Booting'),
    spawn: () => child,
  });
  try {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const outcome = bootIosSim('UDID-A', {
      timeoutMs: 45000,
      label: 'stim-app-tablet',
      out: (message) => messages.push(message),
    }).catch((error) => error);
    child.stdout?.emit('data', 'Waiting on Data Migration\n');
    await vi.advanceTimersByTimeAsync(45000);
    const error = await outcome;
    expect(messages[0]).toContain('stim-app-tablet is still booting after 15s');
    expect(messages[0]).toContain('Waiting on Data Migration');
    expect(messages[0]).toContain('Memory pressure: warning');
    expect(messages[0]).toContain('Boot may be delayed or stalled');
    expect(messages[1]).toContain('Memory pressure: unknown');
    expect(error.message).toContain('Highest observed memory pressure: warning');
    expect(error.message).toContain('unavailable samples: 1');
    expect(error.message).toContain('Stop unused slots in workspaces you own');
    const count = reads;
    await vi.advanceTimersByTimeAsync(60000);
    expect(reads).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
