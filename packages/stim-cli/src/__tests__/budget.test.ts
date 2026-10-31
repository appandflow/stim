import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {
  enforceBudget,
  inspectBudget,
  peekBudget,
  resolveBudget,
  type Budget,
  type BudgetDeps,
  type ReclaimStepName,
} from '../budget.ts';
import { register } from '../cache/cache-manifest.ts';
import { clearWorkspaceOutputs, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import * as idleGc from '../commands/gc/idle.ts';
import * as metroReset from '../supervisor/cache-reset.ts';
import { liveClaimOwner } from './_factories.ts';
import { gcLogFile, readGcLog } from '@stim-cli/core/state';

const GB = 1024;
const BUDGET_ENV = [
  'STIM_BUDGET_MIN_FREE_DISK_GB',
  'STIM_BUDGET_HARD_FLOOR_DISK_GB',
  'STIM_BUDGET_MAX_COMMITTED_MEMORY_GB',
  'STIM_BUDGET_MAX_LIVE_WORKSPACES',
];

let home: string;
let apps: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-budget-'));
  apps = realpathSync(mkdtempSync(join(tmpdir(), 'stim-budget-apps-')));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(apps, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  for (const key of BUDGET_ENV) delete process.env[key];
});

describe('resolveBudget', () => {
  test('the environment overrides the machine config, and a bad value is an error, not a default', () => {
    const config = { projects: {}, repos: {}, budget: { minFreeDiskGb: 50, hardFloorDiskGb: 0 } };
    expect(resolveBudget({ config, env: {}, totalMemoryMb: GB }).budget).toMatchObject({
      minFreeDiskMb: 50 * GB,
      hardFloorDiskMb: 0,
    });
    expect(
      resolveBudget({ config, env: { STIM_BUDGET_MIN_FREE_DISK_GB: '10' }, totalMemoryMb: GB }).budget.minFreeDiskMb,
    ).toBe(10 * GB);
    expect(resolveBudget({ config, env: { STIM_BUDGET_HARD_FLOOR_DISK_GB: 'lots' }, totalMemoryMb: GB }).error).toMatch(
      /STIM_BUDGET_HARD_FLOOR_DISK_GB/,
    );
    expect(
      resolveBudget({ config: { ...config, budget: { maxLiveWorkspaces: 1.5 } }, env: {}, totalMemoryMb: GB }).error,
    ).toMatch(/budget\.maxLiveWorkspaces/);
  });
});

function limits(overrides: Partial<Budget> = {}): Budget {
  return {
    minFreeDiskMb: 20 * GB,
    hardFloorDiskMb: 5 * GB,
    maxCommittedMemoryMb: 0,
    maxLiveWorkspaces: 0,
    ...overrides,
  };
}

function fakeDeps(freeAfterStep: number[], memory: number[] = []) {
  const steps: ReclaimStepName[] = [];
  const deps: Partial<BudgetDeps> = {
    volumes: () => [{ volume: '/', freeMb: freeAfterStep[Math.min(steps.length, freeAfterStep.length - 1)]! }],
    memory: () => ({ committedMb: memory[Math.min(steps.length, memory.length - 1)] ?? 0, liveWorkspaces: 1 }),
    step: async (step) => {
      steps.push(step);
      return { targets: [`${step}-target`], failures: 0 };
    },
    usage: () => ['Stim state /x: 59.0G'],
  };
  return { deps, steps };
}

describe('enforceBudget', () => {
  test('reclaims in order and stops as soon as free disk is back above the floor', async () => {
    const { deps, steps } = fakeDeps([10 * GB, 12 * GB, 25 * GB]);
    const outcome = await enforceBudget({ root: apps, note: () => {}, budget: limits() }, deps);
    expect(steps).toEqual(['idle-devices', 'idle-dev-servers']);
    expect(outcome).toMatchObject({
      status: 'ok',
      reclaimed: [
        { step: 'idle-devices', targets: ['idle-devices-target'], freedMb: 2 * GB },
        { step: 'idle-dev-servers', targets: ['idle-dev-servers-target'], freedMb: 13 * GB },
      ],
    });
  });

  test('what the reclaim steps clear is logged as a budget run, and a dry run logs nothing', async () => {
    const { deps } = fakeDeps([10 * GB, 25 * GB]);
    const recording: Partial<BudgetDeps> = {
      ...deps,
      step: async (step, context) => {
        if (step === 'idle-devices') context.record?.('workspaceOutputs', 'done', '/w/old', { bytes: 4096 });
        return { targets: [`${step}-target`], failures: 0 };
      },
    };
    await enforceBudget({ root: apps, note: () => {}, budget: limits(), dryRun: true }, recording);
    expect(existsSync(gcLogFile())).toBe(false);

    await enforceBudget({ root: apps, note: () => {}, budget: limits() }, recording);
    expect(readGcLog()).toMatchObject([
      { trigger: 'budget', kind: 'workspaceOutputs', status: 'done', label: '/w/old', path: '/w/old', bytes: 4096 },
    ]);
  });

  test('the simulator snapshot is dropped after each reclaim step, so the re-measure lists again', async () => {
    const { deps } = fakeDeps([100 * GB], [30 * GB]);
    let invalidations = 0;
    const simSnapshot = {
      read: () => [],
      invalidate: () => {
        invalidations++;
      },
    };
    await enforceBudget(
      { root: apps, note: () => {}, budget: limits({ maxCommittedMemoryMb: 16 * GB }), simSnapshot },
      deps,
    );
    expect(invalidations).toBe(2);
  });

  test('memory alone reclaims devices and dev servers, never build outputs or caches, and never refuses', async () => {
    const { deps, steps } = fakeDeps([100 * GB], [30 * GB]);
    const notes: string[] = [];
    const outcome = await enforceBudget(
      { root: apps, note: (line) => notes.push(line), budget: limits({ maxCommittedMemoryMb: 16 * GB }) },
      deps,
    );
    expect(steps).toEqual(['idle-devices', 'idle-dev-servers']);
    expect(outcome.status).toBe('ok');
    expect(notes.join('\n')).toMatch(/still over budget/);
  });

  test('under budget it measures and reclaims nothing', async () => {
    const { deps, steps } = fakeDeps([200 * GB]);
    const outcome = await enforceBudget({ root: apps, note: () => {}, budget: limits() }, deps);
    expect(steps).toEqual([]);
    expect(outcome).toMatchObject({ status: 'ok', reclaimed: [] });
  });
});

describe('reclaiming in a scratch STIM_HOME with a floor above the free disk', () => {
  function workspaceWithOutputs(name: string, usedMinutesAgo = 60): string {
    const root = join(apps, name);
    mkdirSync(root);
    upsertProject(root, { isExpo: false });
    mkdirSync(join(ensureWorkspaceStorage(root), 'derived-data', 'Build'), { recursive: true });
    recordWorkspaceUse(root, new Date(Date.now() - usedMinutesAgo * 60_000));
    return root;
  }

  test('the dry run plans only the outputs of other workspaces idle 10 minutes and deletes nothing', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    workspaceWithOutputs('recent', 2);
    const outcome = await enforceBudget({ root: current, note: () => {}, dryRun: true });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const outputs = outcome.reclaimed.find((entry) => entry.step === 'workspace-outputs');
    expect(outputs?.targets).toEqual([other]);
    expect(outcome.reclaimed.map((entry) => entry.step)).not.toContain('idle-devices');
    expect(existsSync(join(workspaceDir(other), 'derived-data'))).toBe(true);

    const doctor = await inspectBudget(current);
    expect(doctor.report?.plan.find((entry) => entry.step === 'workspace-outputs')?.targets).toEqual([other]);
    expect(doctor.findings.map((finding) => finding.title)).toContain('Free disk is below the Stim budget');
  });

  test('a real run clears only the other workspace outputs, then refuses below the hard floor', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '1000000000';
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    const outcome = await enforceBudget({ root: current, note: () => {} }, { usage: () => [] });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.code).toBe('STIM_LOW_DISK');
    expect(outcome.reclaimed.find((entry) => entry.step === 'workspace-outputs')?.targets).toEqual([other]);
    expect(existsSync(join(workspaceDir(other), 'derived-data'))).toBe(false);
    expect(existsSync(join(workspaceDir(current), 'derived-data'))).toBe(true);
    expect(readGcLog()).toMatchObject([{ trigger: 'budget', kind: 'workspaceOutputs', status: 'done', label: other }]);
  });

  test('a real run keeps the outputs of a git-locked worktree and says why', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '1000000000';
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, timeout: 15_000 });
    const repo = join(apps, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const current = workspaceWithOutputs('current');
    const rollback = join(apps, 'rollback');
    git(repo, 'worktree', 'add', '-q', '--detach', rollback);
    git(repo, 'worktree', 'lock', rollback);
    const locked = realpathSync(rollback);
    upsertProject(locked, { isExpo: false });
    mkdirSync(join(ensureWorkspaceStorage(locked), 'derived-data', 'Build'), { recursive: true });
    recordWorkspaceUse(locked, new Date(Date.now() - 60 * 60_000));
    const notes: string[] = [];
    await enforceBudget({ root: current, note: (line) => notes.push(line) }, { usage: () => [] });
    expect(existsSync(join(workspaceDir(locked), 'derived-data'))).toBe(true);
    expect(notes.join('\n')).toContain(`Kept the build outputs of ${locked}: locked`);
  });

  test('outputs of a project inside a git checkout git cannot read are kept', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '1000000000';
    const current = workspaceWithOutputs('current');
    const broken = workspaceWithOutputs('broken');
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/stim-test\n');
    const notes: string[] = [];
    await enforceBudget({ root: current, note: (line) => notes.push(line) }, { usage: () => [] });
    expect(existsSync(join(workspaceDir(broken), 'derived-data'))).toBe(true);
    expect(notes.join('\n')).toContain(
      `Kept the build outputs of ${broken}: git could not tell whether its worktree is locked`,
    );
  });

  test('outputs of a project whose directory is gone are still cleared inside a git checkout', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '1000000000';
    const repo = join(apps, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 15_000 });
    const current = workspaceWithOutputs('current');
    const gone = join(realpathSync(repo), 'gone');
    mkdirSync(gone);
    upsertProject(gone, { isExpo: false });
    mkdirSync(join(ensureWorkspaceStorage(gone), 'derived-data', 'Build'), { recursive: true });
    recordWorkspaceUse(gone, new Date(Date.now() - 60 * 60_000));
    rmSync(gone, { recursive: true });
    await enforceBudget({ root: current, note: () => {} }, { usage: () => [] });
    expect(existsSync(join(workspaceDir(gone), 'derived-data'))).toBe(false);
  });

  test('clearing re-reads the lock a worktree gained after the report was made', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, timeout: 15_000 });
    const repo = join(apps, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = join(apps, 'later-locked');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree);
    const root = realpathSync(worktree);
    upsertProject(root, { isExpo: false });
    mkdirSync(join(ensureWorkspaceStorage(root), 'derived-data', 'Build'), { recursive: true });
    recordWorkspaceUse(root, new Date(Date.now() - 60 * 60_000));
    const report = await collectWorkspaceOutputs({
      olderThan: null,
      now: Date.now(),
      measure: false,
      signal: new AbortController().signal,
    });
    expect(report.workspaces.find((entry) => entry.projectRoot === root)?.willClear).toBe(true);
    git(repo, 'worktree', 'lock', worktree);
    await clearWorkspaceOutputs(
      report,
      { olderThan: null },
      { log: () => {}, error: () => {}, record: () => {}, fail: () => {} },
    );
    expect(existsSync(join(workspaceDir(root), 'derived-data'))).toBe(true);
  });

  test.each(['devices', 'dev servers'] as const)('cancelling idle %s inventory starts no reclamation', async (kind) => {
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    if (kind === 'dev servers')
      upsertProject(other, { metroPort: 31337, supervisor: { ...liveClaimOwner(), port: 31337 } });
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) =>
        file === 'xcrun' ? JSON.stringify({ devices: {} }) : real.runFileAsync(file, args, options),
    });
    const devices = vi.spyOn(idleGc, 'collectIdleDevicesAsync').mockImplementation(async () => {
      if (kind !== 'devices') return [];
      markStarted();
      await gate;
      return [
        {
          kind: 'ios',
          id: 'fixture',
          name: 'stim-fixture',
          project: other,
          slot: 'default',
          lastActivityAt: new Date(0).toISOString(),
          idleForMs: 60_000,
          buildInProgress: false,
        },
      ];
    });
    const activity = vi.spyOn(idleGc, 'collectOwnedDeviceActivityAsync').mockImplementation(async () => {
      markStarted();
      await gate;
      return [];
    });
    const shutdown = vi.spyOn(idleGc, 'shutDownIdleDevices').mockResolvedValue({ failures: 0, shutDown: [] });
    const stop = vi.spyOn(metroReset, 'stopOwnedMetro').mockResolvedValue({ status: 'stopped' });
    const abort = new AbortController();
    const outcome = enforceBudget(
      {
        root: current,
        note: () => {},
        budget: limits(),
        env: { ...process.env, STIM_HOME: undefined },
        signal: abort.signal,
      },
      {
        volumes: () => [{ volume: '/', freeMb: GB }],
        usage: () => [],
      },
    ).catch((error: unknown) => error);
    try {
      expect(await Promise.race([started.then(() => 'probing'), outcome.then(() => 'finished')])).toBe('probing');
      abort.abort(new Error('cancel idle reclamation'));
      release();
      expect(await outcome).toMatchObject({ message: 'cancel idle reclamation' });
      expect(shutdown).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
      devices.mockRestore();
      activity.mockRestore();
      shutdown.mockRestore();
      stop.mockRestore();
    }
  });

  test.skipIf(process.platform !== 'darwin')(
    'cancels pending workspace process probes before deleting outputs',
    async () => {
      const current = workspaceWithOutputs('current');
      const other = workspaceWithOutputs('other');
      mkdirSync(join(workspaceDir(other), 'macos'));
      const abort = new AbortController();
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const real = getExecutor();
      const syncProbe = vi.fn<() => string>(() => '');
      setExecutor({
        ...real,
        runFile: (file, args, options) => (file === 'ps' ? syncProbe() : real.runFile(file, args, options)),
        runFileAsync: async (file, args, options) => {
          if (file !== 'ps') return real.runFileAsync(file, args, options);
          markStarted();
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          });
        },
      });
      const outcome = enforceBudget(
        { root: current, note: () => {}, budget: limits(), signal: abort.signal },
        {
          volumes: () => [{ volume: '/', freeMb: GB }],
          usage: () => [],
        },
      ).catch((error: unknown) => error);
      expect(await Promise.race([started.then(() => 'probing'), outcome.then(() => 'finished')])).toBe('probing');
      await new Promise<void>((resolve) => setImmediate(resolve));
      abort.abort(new Error('cancel workspace preflight'));
      expect(await outcome).toMatchObject({ message: 'cancel workspace preflight' });
      expect(syncProbe).not.toHaveBeenCalled();
      expect(existsSync(join(workspaceDir(other), 'derived-data'))).toBe(true);
    },
  );

  test('cancellation drains a started output deletion under its claim and preserves later outputs', async () => {
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    const dir = workspaceDir(other);
    const first = join(dir, 'derived-data');
    const later = join(dir, 'gradle-build');
    mkdirSync(later);
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realRm = fsPromises.rm;
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === first) {
        markStarted();
        await gate;
      }
      return realRm(path, options);
    });
    syncBuiltinESMExports();
    const abort = new AbortController();
    try {
      const outcome = enforceBudget(
        { root: current, note: () => {}, budget: limits(), signal: abort.signal },
        {
          volumes: () => [{ volume: '/', freeMb: GB }],
          usage: () => [],
        },
      ).catch((error: unknown) => error);
      expect(await Promise.race([started.then(() => 'deleting'), outcome.then(() => 'finished')])).toBe('deleting');
      abort.abort(new Error('cancel output cleanup'));
      const attempt = tryAcquireClaim({ root: join(dir, 'native-run.lock'), mode: 'exclusive' });
      if (attempt.acquired) releaseClaim(attempt.acquired);
      expect(attempt.acquired).toBeUndefined();
      expect(existsSync(later)).toBe(true);
      release();
      expect(await outcome).toMatchObject({ message: 'cancel output cleanup' });
      expect(existsSync(first)).toBe(false);
      expect(existsSync(later)).toBe(true);
      const next = tryAcquireClaim({ root: join(dir, 'native-run.lock'), mode: 'exclusive' });
      assert(next.acquired);
      releaseClaim(next.acquired);
    } finally {
      release();
      remove.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

test('placement budget peek reports shortfalls without running reclaim steps', async () => {
  process.env.STIM_BUDGET_MAX_COMMITTED_MEMORY_GB = '1';
  const { deps, steps } = fakeDeps([], [2 * GB]);
  expect(await peekBudget(apps, deps)).toContain('memory committed');
  expect(steps).toEqual([]);
  process.env.STIM_BUDGET_MAX_COMMITTED_MEMORY_GB = '3';
  expect(await peekBudget(apps, deps)).toBeNull();
  expect(steps).toEqual([]);
});

describe('repeat runs below the disk floor', () => {
  const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
  const MINUTE = 60_000;

  function cacheWithEntry(name: string, ageDays: number): { dir: string; entry: string } {
    const dir = join(apps, name);
    const entry = join(dir, 'entry');
    mkdirSync(entry, { recursive: true });
    const when = new Date(T0 - ageDays * 24 * 60 * MINUTE);
    utimesSync(entry, when, when);
    register({ dir, name, prune: 'entries' });
    return { dir, entry };
  }

  async function run(at: number, freeMb = 10 * GB, dryRun = false) {
    const notes: string[] = [];
    const outcome = await enforceBudget(
      { root: apps, note: (line) => notes.push(line), budget: limits(), dryRun },
      { volumes: () => [{ volume: '/', freeMb }], now: () => at, usage: () => [] },
    );
    return { notes: notes.join('\n'), outcome };
  }

  test('free disk that fell by more than 1 GB since the empty trim ends the skip', async () => {
    cacheWithEntry('cache-a', 1);
    await run(T0, 10 * GB);
    expect((await run(T0 + MINUTE, 10 * GB - 512)).notes).toMatch(/cache trim skipped/);
    expect((await run(T0 + MINUTE, 8 * GB)).notes).toMatch(/1 cache: nothing older than 14d/);
  });

  test('a cache that could not be listed is not recorded as empty, so the next run walks it again', async () => {
    const { dir } = cacheWithEntry('cache-a', 30);
    chmodSync(dir, 0o000);
    try {
      const first = await run(T0);
      expect(first.notes).not.toMatch(/1 cache: nothing older/);
    } finally {
      chmodSync(dir, 0o700);
    }
    const second = await run(T0 + MINUTE);
    expect(second.notes).not.toMatch(/cache trim skipped/);
    expect(existsSync(join(dir, 'entry'))).toBe(false);
  });
});

describe('the STIM_LOW_DISK largest-uses scans', () => {
  test('run at the same time, so the refusal waits for the slowest scan and not for the sum', async () => {
    const fakeHome = join(apps, 'home');
    const dirs = [join(fakeHome, '.android', 'avd')];
    if (process.platform === 'darwin')
      dirs.push(
        join(fakeHome, 'Library', 'Developer', 'CoreSimulator', 'Devices'),
        join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData'),
      );
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    const expected = dirs.length + 1;

    let started = 0;
    let inFlight = 0;
    let peak = 0;
    let everyScanStarted = () => {};
    const barrier = new Promise<void>((resolve) => {
      everyScanStarted = resolve;
    });
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file !== 'du') return real.runFileAsync(file, args, options);
        started++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (started === expected) everyScanStarted();
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 3000))]);
        inFlight--;
        return `${1024 * 1024}\t${args?.[1]}`;
      },
    });
    const outcome = await enforceBudget(
      { root: apps, note: () => {}, budget: limits(), env: { ...process.env, HOME: fakeHome } },
      { volumes: () => [{ volume: '/', freeMb: GB }] },
    );
    expect(peak).toBe(expected);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.message).toMatch(/Largest uses: .*Stim state.*Android emulators/);
  });
});
