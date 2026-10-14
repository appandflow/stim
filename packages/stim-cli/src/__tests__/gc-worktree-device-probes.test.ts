import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorktreeSweep } from '../commands/gc/worktrees.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject } from '../workspace/config.ts';

const SIM = 'OWNED-SIM';
const AVD = 'stim-worktree-device';
const outputs = {
  simulators: JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: SIM, name: 'stim-owned-sim', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iphone' },
      ],
    },
  }),
  AVDs: AVD,
  adb: 'List of devices attached\nemulator-5554\tdevice\n',
  'emulator name': `${AVD}\nOK`,
};

let home: string;
let linked: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-worktree-devices-')));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  resetExecutor();
  const root = join(home, 'repo');
  linked = join(home, 'linked');
  mkdirSync(root);
  const executor = getExecutor();
  executor.runFile('git', ['init', '-q', '-b', 'main', root], { timeoutMs: 5000 });
  executor.runFile(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'initial',
    ],
    { timeoutMs: 5000 },
  );
  executor.runFile('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature', linked], { timeoutMs: 5000 });
  setExecutor({ ...executor, findExecutable: (name) => (name === 'gh' ? null : executor.findExecutable(name)) });
});

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  child = undefined;
  vi.useRealTimers();
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function sdkPhase(file: string, args: string[]): keyof typeof outputs | null {
  if (file === 'xcrun') return 'simulators';
  if (args.includes('-list-avds')) return 'AVDs';
  if (args.includes('devices')) return 'adb';
  if (args.includes('emu') && args.includes('name')) return 'emulator name';
  return null;
}

function registerDevice(ios: boolean) {
  recordCreatedDevice(ios ? 'ios' : 'android', ios ? SIM : AVD);
  upsertProject(linked, {
    metroPort: null,
    platforms: ios ? { ios: { owned: true, deviceUdid: SIM } } : { android: { owned: true, avdName: AVD } },
  });
}

test.each(['simulators', 'AVDs', 'adb', 'emulator name'] as const)(
  'a delayed %s child leaves the report responsive and retains a running owned device',
  async (slow) => {
    registerDevice(slow === 'simulators');
    const executor = getExecutor();
    let responsive: boolean | undefined;
    const delay = ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 150)', '--', outputs[slow]];
    const sync = (file: string, args: string[], options: Parameters<typeof executor.runFile>[2], quiet: boolean) => {
      const phase = sdkPhase(file, args);
      if (!phase) return quiet ? executor.runFileQuiet(file, args, options) : executor.runFile(file, args, options);
      if (phase !== slow) return outputs[phase];
      let ticked = false;
      const timer = setTimeout(() => (ticked = true), 25);
      try {
        const output = executor.runFile(process.execPath, delay, options);
        responsive = ticked;
        return output;
      } finally {
        clearTimeout(timer);
      }
    };
    setExecutor({
      ...executor,
      runFile: (file, args, options) => sync(file, args, options, false) ?? '',
      runFileQuiet: (file, args, options) => sync(file, args, options, true),
      async runFileAsync(file, args, options) {
        const phase = sdkPhase(file, args);
        if (!phase) return executor.runFileAsync(file, args, options);
        if (phase !== slow) return outputs[phase];
        let ticked = false;
        const timer = setTimeout(() => (ticked = true), 25);
        try {
          const output = await executor.runFileAsync(process.execPath, delay, options);
          responsive = ticked;
          return output;
        } finally {
          clearTimeout(timer);
        }
      },
    });
    const report = await collectWorktreeSweep({ idle: true, olderThan: null, now: Date.now(), graceMs: 0 });
    const candidate = report.worktrees.find(({ path }) => path === linked);
    expect(responsive).toBe(true);
    expect(candidate?.skipCode).toBe('in-use');
    expect(candidate?.skipped).toContain(slow === 'simulators' ? 'is Booted' : 'is running');
    expect(existsSync(linked)).toBe(true);
  },
);

test('a stalled simulator inventory is killed at its budget and retains unknown device state', async () => {
  registerDevice(true);
  const executor = getExecutor();
  const { promise: ready, resolve: started } = Promise.withResolvers<void>();
  vi.useFakeTimers();
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) =>
      file === 'xcrun'
        ? executor.runFileAsync(
            process.execPath,
            ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            {
              ...options,
              onSpawn: (spawned) => {
                child = spawned;
                spawned.stdout?.once('data', () => started());
              },
            },
          )
        : executor.runFileAsync(file, args, options),
  });
  const pending = collectWorktreeSweep({ idle: true, olderThan: null, now: Date.now(), graceMs: 0 });
  await ready;
  await vi.advanceTimersByTimeAsync(30_000);
  const report = await pending;
  const candidate = report.worktrees.find(({ path }) => path === linked);
  expect(child?.signalCode).toBe('SIGKILL');
  expect(candidate?.skipCode).toBe('in-use');
  expect(candidate?.skipped).toContain('cannot be read');
  expect(existsSync(linked)).toBe(true);
});

test('an Android device record changed during inventory is refused rather than treated as idle', async () => {
  registerDevice(false);
  const replacement = 'stim-replacement';
  recordCreatedDevice('android', replacement);
  const executor = getExecutor();
  setExecutor({
    ...executor,
    async runFileAsync(file, args, options) {
      const phase = sdkPhase(file, args);
      if (!phase) return executor.runFileAsync(file, args, options);
      if (phase === 'AVDs') {
        const output = await executor.runFileAsync(
          process.execPath,
          ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 150)', '--', AVD],
          options,
        );
        upsertProject(linked, { platforms: { android: { owned: true, avdName: replacement } } });
        return output;
      }
      return outputs[phase];
    },
  });
  const report = await collectWorktreeSweep({ idle: true, olderThan: null, now: Date.now(), graceMs: 0 });
  const candidate = report.worktrees.find(({ path }) => path === linked);
  expect(candidate?.skipCode).toBe('in-use');
  expect(candidate?.skipped).toContain(`owned emulator ${replacement} cannot be read`);
  expect(existsSync(linked)).toBe(true);
});
