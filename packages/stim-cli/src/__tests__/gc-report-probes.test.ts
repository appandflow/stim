import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectParkedAvds, collectParkedSims, withAndroidAvdSizes } from '../commands/gc/devices.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { measureWorktreeSweep } from '../commands/gc/worktree-sizes.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { parkSim } from '../devices/sim-pool.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { upsertProject } from '../workspace/config.ts';

let home: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-report-probes-'));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
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

test.each(['simulators', 'device types', 'AVDs', 'AVD size'] as const)(
  'a slow %s child leaves the event loop responsive while collecting parked devices',
  async (slow) => {
    const ios = slow === 'simulators' || slow === 'device types';
    const platform = ios ? 'ios' : 'android';
    const id = ios ? 'OWNED-SIM' : 'stim-owned-avd';
    recordCreatedDevice(platform, id);
    upsertProject('/source', {
      platforms: ios
        ? { ios: { deviceUdid: id, deviceName: 'stim-owned-sim', owned: true } }
        : { android: { avdName: id, owned: true } },
    });
    parkSim({
      platform,
      projectPath: '/source',
      max: 3,
      record: ios
        ? {
            udid: id,
            name: 'stim-owned-sim',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            deviceTypeIdentifier: 'iphone',
            simslimManaged: false,
            parkedAt: new Date().toISOString(),
          }
        : {
            udid: id,
            name: id,
            systemImage: 'system-images;android-36;google_apis;arm64-v8a',
            configuration: '[]',
            parkedAt: new Date().toISOString(),
          },
    });
    const outputs = {
      simulators: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              udid: id,
              name: 'stim-owned-sim',
              state: 'Shutdown',
              deviceTypeIdentifier: 'iphone',
              isAvailable: true,
              dataPathSize: 1024,
            },
          ],
        },
      }),
      'device types': JSON.stringify({ devicetypes: [{ identifier: 'iphone', name: 'iPhone' }] }),
      AVDs: id,
      'AVD size': `1\t${home}`,
    };
    const probe = (file: string, args: string[]) => {
      if (file === 'du') return 'AVD size';
      if (args.includes('-list-avds')) return 'AVDs';
      if (args.includes('devicetypes')) return 'device types';
      if (args.includes('devices')) return 'simulators';
      throw new Error(`Unexpected report probe: ${file} ${args.join(' ')}`);
    };
    const executor = getExecutor();
    const delay = ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 150)', outputs[slow]];
    setExecutor({
      runFile(file, args, options) {
        const phase = probe(file, args);
        return phase === slow ? executor.runFile(process.execPath, delay, options) : outputs[phase];
      },
      runFileAsync(file, args, options) {
        const phase = probe(file, args);
        return phase === slow
          ? executor.runFileAsync(process.execPath, delay, options)
          : Promise.resolve(outputs[phase]);
      },
    });
    let ticked = false;
    const timer = setTimeout(() => (ticked = true), 25);
    try {
      const report = ios ? await collectParkedSims({}) : await collectParkedAvds({ avdDirectory: () => home });
      expect(ticked).toBe(true);
      expect(report).toMatchObject([
        { listed: true, bytes: 1024, ...(ios ? { udid: id, model: 'iPhone' } : { name: id }) },
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
);

test.each(['workspace outputs', 'orphaned workspace', 'orphaned AVD', 'unlisted worktree'] as const)(
  'a slow %s size probe yields without changing the reported size',
  async (target) => {
    const root = join(home, 'app');
    if (target === 'workspace outputs') mkdirSync(root);
    if (target === 'workspace outputs' || target === 'orphaned workspace') {
      const dir = ensureWorkspaceStorage(root);
      mkdirSync(join(dir, 'derived-data'));
    }
    if (target === 'unlisted worktree') {
      mkdirSync(root);
      const executor = getExecutor();
      executor.runFile('git', ['init', '-q', '-b', 'main', root], { timeoutMs: 5000 });
      executor.runFile(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init'],
        { cwd: root, timeoutMs: 5000 },
      );
      mkdirSync(join(root, '.worktrees', 'lost'), { recursive: true });
      upsertProject(root, { metroPort: null });
    }
    const executor = getExecutor();
    const delay = ['-e', 'setTimeout(() => process.stdout.write("2\\tfixture"), 150)'];
    setExecutor({
      ...executor,
      runFile: (file, args, options) =>
        file === 'du' ? executor.runFile(process.execPath, delay, options) : executor.runFile(file, args, options),
      runFileAsync: (file, args, options) =>
        file === 'du'
          ? executor.runFileAsync(process.execPath, delay, options)
          : executor.runFileAsync(file, args, options),
    });
    let ticked = false;
    const timer = setTimeout(() => (ticked = true), 25);
    try {
      let bytes: number | null | undefined;
      if (target === 'workspace outputs') {
        const report = await collectWorkspaceOutputs({ olderThan: null, now: Date.now() });
        bytes = report.workspaces[0]?.bytes;
      } else if (target === 'orphaned workspace') {
        const report = await collectOrphanedWorkspaces([], ['/']);
        bytes = report.orphaned[0]?.bytes;
      } else if (target === 'orphaned AVD') {
        const report = await withAndroidAvdSizes<{ kind: 'android'; id: string; bytes?: number }>(
          [{ kind: 'android', id: 'stim-owned-avd' }],
          {
            avdDirectory: () => home,
          },
        );
        bytes = report[0]?.bytes;
      } else {
        const report = await measureWorktreeSweep({
          idle: null,
          graceMs: 0,
          now: Date.now(),
          noOwnCommitsIdleMs: null,
          worktrees: [],
        });
        bytes = report.unlisted?.[0]?.bytes;
      }
      expect(ticked).toBe(true);
      expect(bytes).toBe(2048);
    } finally {
      clearTimeout(timer);
    }
  },
);

test('a stalled workspace size probe terminates at its budget and retains unknown size and clearability', async () => {
  const root = join(home, 'app');
  mkdirSync(root);
  const dir = ensureWorkspaceStorage(root);
  mkdirSync(join(dir, 'derived-data'));
  const executor = getExecutor();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  vi.useFakeTimers();
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) =>
      file === 'du'
        ? executor.runFileAsync(
            process.execPath,
            ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
            {
              ...options,
              onSpawn: (spawned) => {
                child = spawned;
                spawned.stdout?.once('data', started);
              },
            },
          )
        : executor.runFileAsync(file, args, options),
  });
  const pending = collectWorkspaceOutputs({ olderThan: null, now: Date.now(), sizeTimeoutMs: 100 });
  await ready;
  await vi.advanceTimersByTimeAsync(100);
  const report = await pending;
  expect(child?.signalCode).toBe('SIGKILL');
  expect(report.workspaces).toMatchObject([{ dir, projectRoot: root, bytes: null, willClear: true }]);
});
