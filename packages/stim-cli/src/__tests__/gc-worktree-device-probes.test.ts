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
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-worktree-devices-')));
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

test('an iOS device assigned during Android inventory is refused when its state was not inspected', async () => {
  registerDevice(true);
  recordCreatedDevice('android', AVD);
  upsertProject(linked, {
    platforms: { ios: { owned: true, deviceUdid: SIM }, android: { owned: true, avdName: AVD } },
  });
  const replacement = 'NEW-OWNED-SIM';
  const executor = getExecutor();
  setExecutor({
    ...executor,
    async runFileAsync(file, args, options) {
      const phase = sdkPhase(file, args);
      if (!phase) return executor.runFileAsync(file, args, options);
      if (phase === 'simulators')
        return JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
              { udid: SIM, name: 'stim-old', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'iphone' },
            ],
          },
        });
      if (phase === 'AVDs') {
        const output = await executor.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], options);
        recordCreatedDevice('ios', replacement);
        upsertProject(linked, {
          platforms: { ios: { owned: true, deviceUdid: replacement }, android: { owned: true, avdName: AVD } },
        });
        return output;
      }
      return outputs[phase];
    },
  });
  const report = await collectWorktreeSweep({ idle: true, olderThan: 0, now: Date.now(), graceMs: 0 });
  const candidate = report.worktrees.find(({ path }) => path === linked);
  expect(candidate?.skipCode).toBe('in-use');
  expect(candidate?.skipped).toContain(`owned simulator ${replacement} cannot be read`);
  expect(existsSync(linked)).toBe(true);
});
