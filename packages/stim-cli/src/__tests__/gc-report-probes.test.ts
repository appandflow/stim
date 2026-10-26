import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectParkedAvds, collectParkedSims, withAndroidAvdSizes } from '../commands/gc/devices.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { measureWorktreeSweep } from '../commands/gc/worktree-sizes.ts';
import { collectWorktreeSweep } from '../commands/gc/worktrees.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { volumeRootFor } from '../fs-util.ts';
import { parkSim } from '../devices/sim-pool.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { upsertProject } from '../workspace/config.ts';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { runReport } from '../report-runtime.ts';
import { testContext } from './_context.ts';

let home: string;
let child: ChildProcess | undefined;
let reportAbort: AbortController | undefined;
let activeReport: Promise<unknown> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-report-probes-'));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
});

afterEach(async () => {
  reportAbort?.abort();
  await activeReport?.catch(() => {});
  reportAbort = undefined;
  activeReport = undefined;
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

function gatedProbe() {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    run<T>(probe: () => Promise<T>): Promise<T> {
      markStarted();
      return released.then(probe);
    },
    async settle<T>(report: Promise<T>): Promise<T> {
      const pending = await Promise.race([started.then(() => true), report.then(() => false)]);
      expect(pending).toBe(true);
      release();
      return report;
    },
  };
}

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
    const gate = gatedProbe();
    setExecutor({
      runFile(file, args, options) {
        const phase = probe(file, args);
        return phase === slow ? executor.runFile(process.execPath, delay, options) : outputs[phase];
      },
      runFileAsync(file, args, options) {
        const phase = probe(file, args);
        return phase === slow
          ? gate.run(() => executor.runFileAsync(process.execPath, delay, options))
          : Promise.resolve(outputs[phase]);
      },
    });
    const report = ios
      ? await gate.settle(collectParkedSims({}))
      : await gate.settle(collectParkedAvds({ avdDirectory: () => home }));
    expect(report).toMatchObject([
      { listed: true, bytes: 1024, ...(ios ? { udid: id, model: 'iPhone' } : { name: id }) },
    ]);
  },
);

test.each([
  'workspace outputs',
  'orphaned workspace',
  'orphaned AVD',
  'unlisted worktree',
  'worktree build state',
] as const)(
  'a slow %s size probe yields and records its owned child without changing the reported size',
  async (target) => {
    const root = join(home, 'app');
    if (target === 'workspace outputs') mkdirSync(root);
    if (target === 'workspace outputs' || target === 'orphaned workspace') {
      const dir = ensureWorkspaceStorage(root);
      mkdirSync(join(dir, 'derived-data'));
    }
    if (target === 'unlisted worktree' || target === 'worktree build state') {
      mkdirSync(root);
      const executor = getExecutor();
      executor.runFile('git', ['init', '-q', '-b', 'main', root], { timeoutMs: 5000 });
      executor.runFile(
        'git',
        [
          '-c',
          'user.email=test@example.com',
          '-c',
          'user.name=test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: root, timeoutMs: 5000 },
      );
      if (target === 'unlisted worktree') mkdirSync(join(root, '.worktrees', 'lost'), { recursive: true });
      else {
        mkdirSync(join(root, 'node_modules'));
        mkdirSync(join(root, 'android', 'build'), { recursive: true });
      }
      upsertProject(root, { metroPort: null });
    }
    const executor = getExecutor();
    const delay = ['-e', 'setTimeout(() => process.stdout.write("2\\tfixture"), 150)'];
    const gate = gatedProbe();
    let claimRoot = '';
    const probePids: number[] = [];
    const recordedPids: (number | undefined)[] = [];
    let active = 0;
    let peak = 0;
    setExecutor({
      ...executor,
      runFile: (file, args, options) =>
        file === 'du' ? executor.runFile(process.execPath, delay, options) : executor.runFile(file, args, options),
      runFileAsync: (file, args, options) =>
        file === 'du'
          ? gate.run(() =>
              executor.runFileAsync(process.execPath, delay, {
                ...options,
                onSpawn: (spawned) => {
                  options.onSpawn?.(spawned);
                  child = spawned;
                  if (spawned.pid === undefined) throw new Error('The size probe has no PID');
                  probePids.push(spawned.pid);
                  recordedPids.push(readClaimSet(claimRoot).live[0]?.child?.pid);
                  peak = Math.max(peak, ++active);
                  spawned.once('close', () => active--);
                },
              }),
            )
          : executor.runFileAsync(file, args, options),
    });
    const measure = async (operation: StimContext) => {
      if (target === 'workspace outputs') {
        const report = await gate.settle(
          collectWorkspaceOutputs({ olderThan: null, now: Date.now(), operation, signal: operation.signal }),
        );
        return report.workspaces[0]?.bytes;
      }
      if (target === 'orphaned workspace') {
        const report = await gate.settle(collectOrphanedWorkspaces([], [volumeRootFor(home)], { operation }));
        return report.orphaned[0]?.bytes;
      }
      if (target === 'orphaned AVD') {
        const report = await gate.settle(
          withAndroidAvdSizes<{ kind: 'android'; id: string; bytes?: number }>(
            [{ kind: 'android', id: 'stim-owned-avd' }],
            {
              avdDirectory: () => home,
              operation,
            },
          ),
        );
        return report[0]?.bytes;
      }
      const report = await gate.settle(
        measureWorktreeSweep(
          {
            idle: null,
            graceMs: 0,
            now: Date.now(),
            noOwnCommitsIdleMs: null,
            worktrees:
              target === 'worktree build state'
                ? (await collectWorktreeSweep({ idle: true, olderThan: null, graceMs: 0, now: Date.now(), operation }))
                    .worktrees
                : [],
          },
          operation,
        ),
      );
      return target === 'worktree build state' ? report.worktrees[0]?.buildState?.bytes : report.unlisted?.[0]?.bytes;
    };
    reportAbort = new AbortController();
    const pending = runReport(
      testContext({ home, projectRoot: root, cwd: home, signal: reportAbort.signal }),
      (operation) =>
        withAmbientContext(operation, () =>
          withWorkspaceProcessLock(
            home,
            'size-probe',
            async (claim) => {
              claimRoot = claim.root;
              return measure(operation);
            },
            { external: true, declareSpawnsFor: operation },
          ),
        ),
    );
    activeReport = pending;
    const bytes = await pending;
    expect(bytes).toBe(target === 'worktree build state' ? 4096 : 2048);
    expect(probePids.length).toBeGreaterThan(0);
    expect(recordedPids).toEqual(probePids);
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(readClaimSet(claimRoot).live).toEqual([]);
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
