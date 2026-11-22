import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  diskUsageCacheFile,
  gcMarkFile,
  readGcMark,
  GC_MARK_VERSION,
  type Config,
  type GcMark,
} from '@stim-cli/core/state';
import * as discovery from '../workspace/discovery.ts';
import * as gcPaths from '../commands/gc/paths.ts';
import * as cacheFiles from '../cache-file.ts';
import * as worktree from '../workspace/worktree.ts';
import { runLadder } from '../daemon/ladder.ts';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { dependencyMarkObserver } from '../daemon/dependency-marks.ts';
import { savedDependencyReports } from '../daemon/dependency-reports.ts';
import * as artifacts from '../stimd/passes/artifacts.ts';
import { markDue, markWriter, outputMarks, outputMark, refreshOutputMarks } from '../daemon/marks.ts';
import { stoppedOutputCandidates, stoppedOutputs } from '../daemon/stages.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import { saveConfig } from '../workspace/config.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { recordWarmedFrom } from '../workspace/source-dependencies.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { readRunningProcessesAsync } from '../workspace/running-from.ts';
import { treeSignature } from '../private-size.ts';
import { hungRead, pendingRead, Unanswered } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: vi.fn<typeof fs.lstat>(fs.lstat),
    realpath: vi.fn<typeof fs.realpath>(fs.realpath),
    stat: vi.fn<typeof fs.stat>(fs.stat),
  };
});

vi.mock('../workspace/protected-locations.ts', () => ({
  isProtectedLocation: () => false,
}));

const reads = vi.hoisted(() => ({ packages: 0, configs: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = new Proxy(fs.readFileSync, {
    apply(target, self, args: Parameters<typeof fs.readFileSync>) {
      if (String(args[0]).endsWith('package.json')) reads.packages++;
      if (String(args[0]).endsWith('config.json')) reads.configs++;
      return Reflect.apply(target, self, args);
    },
  });
  return { ...fs, readFileSync, default: { ...fs, readFileSync } };
});

vi.mock('../workspace/running-from.ts', async (importOriginal) => {
  const module = await importOriginal<typeof import('../workspace/running-from.ts')>();
  return {
    ...module,
    readRunningProcessesAsync: vi.fn<typeof module.readRunningProcessesAsync>(module.readRunningProcessesAsync),
  };
});

const day = 86_400_000;
const reading = { devices: [], simsFailed: false };

describe('gc marks written by the lane', () => {
  let base: string;
  let roots: string;
  let config: Config;

  const checkout = (name: string, agedMs: number) => {
    const path = join(roots, name);
    mkdirSync(join(path, 'android'), { recursive: true });
    writeFileSync(join(path, 'android', 'build.gradle'), '');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, '.gitignore'), 'build/\nnode_modules/\ntarget/\n');
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          path,
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          ...args,
        ],
        {
          env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
        },
      );
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    mkdirSync(join(path, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(path, 'android', 'app', 'build', 'out.bin'), 'x');
    const at = new Date(Date.now() - agedMs);
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) age(child);
        utimesSync(child, at, at);
      }
      utimesSync(dir, at, at);
    };
    age(path);
    return path;
  };

  const lane = (marks?: true, devices: OwnedDeviceActivity[] = []) =>
    runDormantDependencies({
      config,
      act: false,
      log: () => {},
      ...reading,
      devices,
      operation: testContext(),
      ...(marks ? { marks } : {}),
    });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-marks-')));
    roots = join(base, 'roots');
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle: { sourceDormantDays: 0 } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it.each(['batch', 'selected'])(
    'cancels a stalled %s identity read without starting another checkout read',
    async (mode) => {
      const root = join(base, 'first');
      config.projects = { [root]: {}, [join(base, 'second')]: {} };
      let release: (root: string) => void = () => {};
      const pending = new Promise<string>((done) => {
        release = done;
      });
      const lookup = vi.spyOn(gcPaths, 'realpathAsync').mockReturnValue(pending);
      const controller = new AbortController();
      if (mode === 'selected') {
        mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
        writeFileSync(
          gcMarkFile(root),
          JSON.stringify({
            v: GC_MARK_VERSION,
            root,
            device: 1,
            markedAt: new Date().toISOString(),
            lastActivityAt: null,
            candidates: [],
          }),
        );
      }
      const operation = testContext({ signal: controller.signal });
      const refused = (
        mode === 'selected' ? outputMark(config, root, operation) : outputMarks(config, operation)
      ).catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
        controller.abort(new Error('stop'));
        await expect(refused).resolves.toMatchObject({ message: 'stop' });
        expect(hungRead()).toBe(root);
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally {
        release(root);
        await pendingRead();
      }
    },
  );

  it.each([
    { activityAge: 0, elapsed: 10 * 60_000 - 1, dirty: false, due: false },
    { activityAge: 0, elapsed: 10 * 60_000, dirty: false, due: true },
    { activityAge: 2 * day, elapsed: 60 * 60_000 - 1, dirty: false, due: false },
    { activityAge: 2 * day, elapsed: 60 * 60_000, dirty: false, due: true },
    { activityAge: 8 * day, elapsed: day - 1, dirty: false, due: false },
    { activityAge: 8 * day, elapsed: day, dirty: false, due: true },
    { activityAge: 8 * day, elapsed: 10 * 60_000 - 1, dirty: true, due: false },
    { activityAge: 8 * day, elapsed: 10 * 60_000, dirty: true, due: true },
  ])('uses the approved mark cadence: $activityAge old, $elapsed since mark, dirty $dirty', (row) => {
    const now = Date.now();
    const mark: GcMark = {
      v: GC_MARK_VERSION,
      root: '/root',
      device: 1,
      markedAt: new Date(now - row.elapsed).toISOString(),
      lastActivityAt: new Date(now - row.activityAge).toISOString(),
      candidates: [],
      ...(row.dirty ? { dirtyAt: new Date(now).toISOString() } : {}),
    };
    expect(markDue(mark, now, 7 * day)).toBe(row.due);
  });

  it('marks untagged sibling Cargo targets under the real holder without authorizing holder outputs through a registered app', async () => {
    const holder = checkout('monorepo', 2 * day);
    const app = join(holder, 'apps', 'mobile');
    const rust = join(holder, 'packages', 'native');
    mkdirSync(app, { recursive: true });
    mkdirSync(join(rust, 'target', 'debug', '.fingerprint'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname="native"\nversion="0.1.0"\n');
    writeFileSync(join(rust, 'target', '.rustc_info.json'), '{}');
    config.projects[app] = {};
    saveConfig(config);
    await markWriter(config)({ path: holder, at: Date.now(), lastActivityAt: null, kept: null });
    const saved = readGcMark(holder);
    if (!saved) throw new Error('missing holder mark');
    expect(saved.candidates.some(({ kind }) => kind === 'outputs')).toBe(true);
    expect(saved.candidates).toContainEqual(
      expect.objectContaining({ kind: 'cargo-target', path: join(rust, 'target') }),
    );
    const allowed = (await outputMarks(config, testContext())).find(({ root }) => root === holder);
    if (!allowed) throw new Error('missing authorized Cargo holder');
    expect(allowed.candidates.map(({ kind }) => kind)).toEqual(['cargo-target']);
    config.projects = {};
    config.maintenance = { autoDiscover: false };
    saveConfig(config);
    expect(await outputMarks(config, testContext())).toEqual([]);
  });

  it('high refresh records current activity and keeps instead of fabricating an idle checkout', async () => {
    const path = checkout('recent', 0);
    config.projects[path] = {};
    saveConfig(config);
    recordWorkspaceUse(path, new Date());

    const refreshed = await refreshOutputMarks(config, reading);

    expect(refreshed).toHaveLength(1);
    expect(Date.parse(readGcMark(path)?.lastActivityAt ?? '')).toBeGreaterThanOrEqual(Date.now() - 60_000);
    expect(markDue(readGcMark(path), Date.now(), 7 * day)).toBe(false);
  });

  it('reclaims marked workspace output on a different device from its checkout', async () => {
    const path = checkout('external-checkout', 3 * day);
    config.projects[path] = {};
    saveConfig(config);
    recordWorkspaceUse(path, new Date(Date.now() - 3 * day));
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const actualDevice = (await fs.stat(path)).dev;
    vi.mocked(stat).mockImplementation(async (file) => {
      const info = await fs.stat(file);
      return String(file) === path ? Object.assign(info, { dev: actualDevice + 1 }) : info;
    });
    await markWriter(config)({ path, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
    const output = join(path, 'android', 'app', 'build');
    expect(readGcMark(path)?.device).toBe(actualDevice + 1);
    expect(readGcMark(path)?.candidates[0]?.device).toBe(actualDevice);
    const pressure = {
      level: 'critical' as const,
      disk: 'critical' as const,
      memory: 'normal' as const,
      reasons: [],
      memoryWarningSince: null,
    };

    const { actions } = await runLadder(
      {
        config,
        act: true,
        log: () => {},
        ...reading,
        fromRung: 1,
        lastRung: 1,
        force: { level: 'critical', why: 'test' },
        remeasure: async () => pressure,
        operation: testContext(),
      },
      pressure,
    );

    expect(existsSync(output)).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ rung: 1, outcome: 'done' }));
  });

  it('keeps marked outputs when the targeted root safety read times out', async () => {
    const path = checkout('unanswered-recheck', 3 * day);
    config.projects[path] = {};
    saveConfig(config);
    recordWorkspaceUse(path, new Date(Date.now() - 3 * day));
    await markWriter(config)({ path, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
    vi.mocked(stat).mockRejectedValueOnce(new Unanswered('root safety deadline'));
    const pressure = {
      level: 'critical' as const,
      disk: 'critical' as const,
      memory: 'normal' as const,
      reasons: [],
      memoryWarningSince: null,
    };

    const { actions } = await runLadder(
      {
        config,
        act: true,
        log: () => {},
        ...reading,
        fromRung: 1,
        lastRung: 1,
        force: { level: 'critical', why: 'test' },
        remeasure: async () => pressure,
        operation: testContext(),
      },
      pressure,
    );

    expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(true);
    expect(actions).toContainEqual(
      expect.objectContaining({ rung: 1, outcome: 'kept', detail: expect.stringContaining('root safety deadline') }),
    );
  });

  it('loads registered-only marks without reading discovery topology', async () => {
    const path = checkout('registered', 3 * day);
    config.projects[path] = {};
    await markWriter(config)({ path, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
    const source = vi.spyOn(worktree, 'resolveSourceCheckoutAsync');

    expect((await outputMarks(config, testContext())).map(({ root }) => root)).toEqual([path]);

    expect(source).not.toHaveBeenCalled();
  });

  it.each(['checkout', 'output'] as const)(
    'keeps the mark identity when native realpath expands the %s spelling',
    async (kind) => {
      const path = checkout('canonical-spelling', 3 * day);
      config.projects[path] = {};
      saveConfig(config);
      recordWorkspaceUse(path, new Date(Date.now() - 3 * day));
      await markWriter(config)({ path, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
      const output = join(path, 'android', 'app', 'build');
      const nativePath = kind === 'checkout' ? path : output;
      const nativeAlias = join(base, 'expanded-native-spelling', kind);
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(realpath).mockImplementation(async (value) =>
        String(value) === nativePath ? nativeAlias : fs.realpath(value),
      );
      expect(await realpath(nativePath)).toBe(nativeAlias);
      const pressure = {
        level: 'critical' as const,
        disk: 'critical' as const,
        memory: 'normal' as const,
        reasons: [],
        memoryWarningSince: null,
      };

      const { actions } = await runLadder(
        {
          config,
          act: true,
          log: () => {},
          ...reading,
          fromRung: 1,
          lastRung: 1,
          force: { level: 'critical', why: 'test' },
          remeasure: async () => pressure,
          operation: testContext(),
        },
        pressure,
      );

      expect(existsSync(output)).toBe(false);
      expect(actions).toContainEqual(expect.objectContaining({ rung: 1, outcome: 'done' }));
      expect(readGcMark(path)?.root).toBe(path);
    },
  );

  it('skips disabled historical scope before reading a stale mark and still reclaims registered outputs', async () => {
    const path = checkout('registered-live', 3 * day);
    const stale = checkout('historical-stale', 3 * day);
    config = { projects: { [path]: {}, [stale]: {} }, repos: {} };
    saveConfig(config);
    recordWorkspaceUse(path, new Date(Date.now() - 3 * day));
    const write = markWriter(config);
    for (const root of [path, stale])
      await write({ path: root, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
    delete config.projects[stale];
    saveConfig(config);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(realpath).mockImplementation(async (value) => {
      if (String(value) === stale) throw new Unanswered('stale mount');
      return fs.realpath(value);
    });
    const pressure = {
      level: 'critical' as const,
      disk: 'critical' as const,
      memory: 'normal' as const,
      reasons: [],
      memoryWarningSince: null,
    };

    await runLadder(
      {
        config,
        act: true,
        log: () => {},
        ...reading,
        fromRung: 1,
        lastRung: 1,
        force: { level: 'critical', why: 'test' },
        remeasure: async () => pressure,
        operation: testContext(),
      },
      pressure,
    );

    expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(false);
    expect(existsSync(join(stale, 'android', 'app', 'build'))).toBe(true);
    expect(vi.mocked(realpath).mock.calls.map(([root]) => String(root))).not.toContain(stale);
  });

  it('critical output sweep uses an authorized automatic sibling mark without full discovery or remarking', async () => {
    vi.stubEnv('HOME', join(base, 'user'));
    vi.stubEnv('USERPROFILE', join(base, 'user'));
    vi.stubEnv('STIM_HOME', '');
    const known = checkout('known-automatic', 3 * day);
    const path = checkout('automatic-sibling', 3 * day);
    config = { projects: { [known]: {} }, repos: {}, maintenance: { autoDiscover: true } };
    saveConfig(config);
    await markWriter(config)({ path, at: Date.now(), lastActivityAt: Date.now() - 3 * day, kept: null });
    const before = readGcMark(path);
    const fullDiscovery = vi.spyOn(discovery, 'discoverCheckouts');
    const pressure = {
      level: 'critical' as const,
      disk: 'critical' as const,
      memory: 'normal' as const,
      reasons: [],
      memoryWarningSince: null,
    };

    const { actions } = await runLadder(
      {
        config,
        act: true,
        log: () => {},
        ...reading,
        fromRung: 1,
        lastRung: 1,
        force: { level: 'critical', why: 'test' },
        remeasure: async () => pressure,
        operation: testContext(),
      },
      pressure,
    );

    expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ rung: 1, workspace: path, outcome: 'done' }));
    expect(fullDiscovery).not.toHaveBeenCalled();
    expect(readGcMark(path)?.markedAt).toBe(before?.markedAt);
  });

  it('marks each checkout the walk reads with the outputs rung 1 would delete there, sized from the cache', async () => {
    const idle = checkout('idle', 3 * day);
    const active = checkout('active', 0);
    saveConfig(config);
    const build = join(idle, 'android', 'app', 'build');
    mkdirSync(dirname(diskUsageCacheFile(build)), { recursive: true });
    const measuredAt = new Date(Date.now() - day).toISOString();
    writeFileSync(diskUsageCacheFile(build), JSON.stringify({ path: build, bytes: 4096, measuredAt }));

    await lane(true);

    const plan = await stoppedOutputCandidates(config, reading, 2 * 60_000);
    expect(plan.map(({ path }) => path)).toEqual([idle]);
    const [candidate] = plan;
    if (!candidate) throw new Error('rung 1 planned nothing');
    const planned = await stoppedOutputs(candidate, config);
    expect(planned).toEqual({ paths: [build], kept: [] });
    const mark = readGcMark(idle);
    expect(mark?.candidates).toEqual([
      { kind: 'outputs', path: build, device: expect.any(Number), bytes: 4096, measuredAt },
    ]);
    expect(Date.parse(mark?.lastActivityAt ?? '')).toBeLessThanOrEqual(Date.now() - 3 * day);

    const busy = readGcMark(active);
    expect(busy?.candidates).toEqual([
      {
        kind: 'outputs',
        path: join(active, 'android', 'app', 'build'),
        device: expect.any(Number),
        bytes: null,
        measuredAt: null,
      },
    ]);
    expect(Date.parse(busy?.lastActivityAt ?? '')).toBeGreaterThan(Date.now() - day);
  }, 20_000);

  it.each(['layout', 'root device'] as const)('retains the complete mark when the %s read stalls', async (kind) => {
    const path = checkout('idle', 3 * day);
    const write = markWriter(config);
    const input = { path, at: Date.now(), lastActivityAt: null, kept: null };
    await write(input);
    const previous = readGcMark(path);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    if (kind === 'layout') {
      vi.mocked(lstat).mockImplementationOnce(async (...args) => {
        started();
        await stalled;
        return fs.lstat(...args);
      });
    } else {
      vi.mocked(stat).mockImplementationOnce(async (...args) => {
        started();
        await stalled;
        return fs.stat(...args);
      });
    }
    const attempt = write({ ...input, at: input.at + 1 });
    const rejected = attempt.catch((error: unknown) => error);
    await ready;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await rejected).toBeInstanceOf(Unanswered);
    expect(readGcMark(path)).toEqual(previous);
    expect(hungRead()).not.toBeNull();
    await expect(write(input)).rejects.toBeInstanceOf(Unanswered);
    release();
    await pendingRead();
    expect(hungRead()).toBeNull();
    expect(readGcMark(path)).toEqual(previous);
    await write({ ...input, at: input.at + 2 });
    expect(readGcMark(path)?.markedAt).toBe(new Date(input.at + 2).toISOString());
  });

  it('retains the complete mark when a layout probe fails without proving absence', async () => {
    const path = checkout('idle', 3 * day);
    const write = markWriter(config);
    const input = { path, at: Date.now(), lastActivityAt: null, kept: null };
    await write(input);
    const previous = readGcMark(path);
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(lstat).mockRejectedValueOnce(failure);

    await expect(write({ ...input, at: input.at + 1 })).rejects.toBe(failure);

    expect(readGcMark(path)).toEqual(previous);
    expect(hungRead()).toBeNull();
  });

  it('refreshes the existing mark key and dirtyAt when the checkout spelling differs in case', async (context) => {
    checkout('idle', 3 * day);
    const alias = join(roots, 'IDLE');
    if (!existsSync(alias)) context.skip();
    const root = realpathSync(alias);
    const dirtyAt = new Date(Date.now() + 60_000).toISOString();
    mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
    writeFileSync(
      gcMarkFile(root),
      JSON.stringify({
        v: GC_MARK_VERSION,
        root,
        device: 1,
        markedAt: new Date(0).toISOString(),
        dirtyAt,
        lastActivityAt: null,
        candidates: [],
      }),
    );
    const at = Date.now();

    await markWriter(config)({ path: alias, at, lastActivityAt: null, kept: null });

    expect(readGcMark(root)).toMatchObject({ root, markedAt: new Date(at).toISOString(), dirtyAt });
    expect(readGcMark(root)?.candidates).toHaveLength(1);
  });

  it('records why a checkout with something running is kept on each of its candidates', async () => {
    const idle = checkout('idle', 3 * day);
    saveConfig(config);
    const device: OwnedDeviceActivity = {
      kind: 'ios',
      id: 'sim',
      name: 'sim',
      project: idle,
      slot: 'default',
      activity: { state: 'idle', basis: [] },
    };

    await lane(true, [device]);

    expect(readGcMark(idle)?.candidates).toEqual([
      expect.objectContaining({ kind: 'outputs', keep: { reason: 'something of it runs', at: expect.any(String) } }),
    ]);
  }, 20_000);

  it('writes no mark from a walk that does not ask for marks', async () => {
    checkout('idle', 3 * day);
    saveConfig(config);

    await lane();
    await stoppedOutputCandidates(config, reading, 2 * 60_000);

    expect(existsSync(join(base, 'home', 'gc', 'marks'))).toBe(false);
  }, 20_000);

  it('observes younger dependency trees with the existing enabled normal inventories and discovers only once per phase', async () => {
    const root = checkout('young-source', 2 * 60 * 60_000);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    config.projects[root] = {};
    config.idle = { dormantDays: 1, sourceDormantDays: 7 };
    saveConfig(config);
    const discoveryReads = vi.spyOn(discovery, 'discoverCheckouts');
    const inventoryReads = vi.spyOn(artifacts, 'collectArtifactsAsync');

    await lane(true);

    expect(discoveryReads).toHaveBeenCalledTimes(2);
    expect(inventoryReads).toHaveBeenCalledTimes(2);
    expect(readGcMark(root)?.dependencies).toMatchObject({
      role: 'source',
      keys: [root],
      candidates: [{ path: join(root, 'node_modules') }],
    });
    expect(existsSync(join(root, 'node_modules'))).toBe(true);
  }, 20_000);

  it('does no inventory or discovery when both normal producers are disabled and reports unknown saved evidence', async () => {
    const root = checkout('disabled', 2 * day);
    config.projects[root] = {};
    config.idle = { dormantDays: 0, sourceDormantDays: 0 };
    saveConfig(config);
    const discover = vi.spyOn(discovery, 'discoverCheckouts');
    const collect = vi.spyOn(artifacts, 'collectArtifactsAsync');

    await lane(true);
    const reports = await savedDependencyReports(config, {
      ...reading,
      level: 'critical',
      operation: testContext(),
      onVolume: () => true,
    });

    expect(discover).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(readGcMark(root)).toBeNull();
    expect(reports).toEqual([
      expect.objectContaining({ target: root, detail: expect.stringContaining('inventory is unknown') }),
    ]);
  });

  const normalLinkedDependencies = async () => {
    const source = checkout('normal-dep-source', 3 * day);
    const root = join(roots, 'normal-dep-linked');
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      'worktree',
      'add',
      '-q',
      '-b',
      'linked',
      root,
    ]);
    const modules = join(root, 'node_modules');
    mkdirSync(modules);
    writeFileSync(join(modules, 'dependency.js'), 'installed');
    config.projects[root] = {};
    saveConfig(config);
    recordWorkspaceUse(root, new Date(Date.now() - 3 * day));
    const old = new Date(Date.now() - 3 * day);
    const age = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) age(child);
        utimesSync(child, old, old);
      }
      utimesSync(path, old, old);
    };
    age(roots);
    await lane(true);
    const cache = () => {
      mkdirSync(dirname(diskUsageCacheFile(modules)), { recursive: true });
      writeFileSync(
        diskUsageCacheFile(modules),
        JSON.stringify({
          path: modules,
          bytes: 1024 ** 3,
          privateBytes: 1024 ** 3,
          measuredAt: new Date().toISOString(),
          signature: treeSignature(modules),
        }),
      );
    };
    return { root, modules, age, old, cache };
  };

  describe.skipIf(process.platform === 'win32')('normal linked dependency selection', () => {
    it('normal linked dependencies select the saved generation and leave a new unmarked tree', async () => {
      const { root, modules, age, cache } = await normalLinkedDependencies();
      const before = readGcMark(root)?.dependencies;
      expect(before?.candidates).toContainEqual(expect.objectContaining({ path: modules }));
      const pods = join(root, 'ios', 'Pods');
      mkdirSync(pods, { recursive: true });
      writeFileSync(join(pods, 'new-pod'), 'new unmarked tree');
      age(roots);
      cache();
      const probes = vi.mocked(stat);
      probes.mockClear();

      const actions = await runDormantDependencies({
        config,
        act: true,
        marks: true,
        log: () => {},
        ...reading,
        operation: testContext(),
      });

      expect(actions).toContainEqual(
        expect.objectContaining({ kind: 'delete-dependencies', target: modules, outcome: 'done' }),
      );
      expect(existsSync(modules)).toBe(false);
      expect(existsSync(join(pods, 'new-pod'))).toBe(true);
      expect(probes.mock.calls.some(([path]) => String(path) === pods)).toBe(false);
      expect(readGcMark(root)?.dependencies).toEqual(before);
    }, 20_000);

    it.each(['missing', 'due', 'failed-publication'] as const)(
      'normal linked dependencies publish a %s generation before selection',
      async (mode) => {
        const { root, modules, old, cache } = await normalLinkedDependencies();
        const mark = readGcMark(root);
        if (!mark?.dependencies) throw new Error('fixture dependency mark missing');
        if (mode === 'due') mark.dependencies.markedAt = old.toISOString();
        else delete mark.dependencies;
        writeFileSync(gcMarkFile(root), JSON.stringify(mark));
        if (mode === 'failed-publication') vi.spyOn(cacheFiles, 'writeCacheFile').mockImplementation(() => {});
        cache();

        const actions = await runDormantDependencies({
          config,
          act: true,
          marks: true,
          log: () => {},
          ...reading,
          operation: testContext(),
        });

        expect(actions.some((action) => action.target === modules && action.outcome === 'done')).toBe(
          mode !== 'failed-publication',
        );
        expect(existsSync(modules)).toBe(mode === 'failed-publication');
        expect(readGcMark(root)?.dependencies?.markedAt).toBe(
          mode === 'failed-publication' ? undefined : new Date().toISOString(),
        );
      },
      20_000,
    );

    it.each(['due', 'dirty', 'device', 'scope', 'setting', 'keys'] as const)(
      'normal linked dependencies keep a selected tree when current %s proof changes before execution',
      async (change) => {
        const { root, modules, cache } = await normalLinkedDependencies();
        cache();
        const list = artifacts.artifactWorktreesFor;
        let changed = false;
        vi.spyOn(artifacts, 'artifactWorktreesFor').mockImplementation(async (operation) => {
          const worktrees = await list(operation);
          changed = true;
          if (change === 'scope' || change === 'setting') {
            if (change === 'scope') {
              config.projects = {};
              config.maintenance = { autoDiscover: false };
              rmSync(workspaceDir(root), { recursive: true, force: true });
            } else config.idle = { dormantDays: 0, sourceDormantDays: 0 };
            saveConfig(config);
          } else {
            const mark = readGcMark(root);
            if (!mark?.dependencies) throw new Error('fixture dependency mark missing');
            if (change === 'due') vi.setSystemTime(Date.now() + 2 * day);
            else if (change === 'dirty') {
              vi.setSystemTime(Date.now() + 20 * 60_000);
              mark.dirtyAt = new Date().toISOString();
            } else if (change === 'keys') mark.dependencies.keys = [];
            else {
              const candidate = mark.dependencies.candidates.find(({ path }) => path === modules);
              if (!candidate) throw new Error('fixture dependency candidate missing');
              candidate.device++;
            }
            writeFileSync(gcMarkFile(root), JSON.stringify(mark));
          }
          return worktrees;
        });

        const actions = await runDormantDependencies({
          config,
          act: true,
          marks: true,
          log: () => {},
          ...reading,
          operation: testContext(),
        });

        expect(changed).toBe(true);
        expect(actions).toContainEqual(
          expect.objectContaining({ kind: 'delete-dependencies', target: modules, outcome: 'kept' }),
        );
        expect(actions.some(({ outcome }) => outcome === 'failed')).toBe(false);
        expect(existsSync(join(modules, 'dependency.js'))).toBe(true);
      },
      20_000,
    );
  });

  describe.skipIf(process.platform === 'win32')('current normal linked dependency authorization', () => {
    it('keeps a former nested app dependency after its registration changes while holder and mark stay intact', async () => {
      const { root, modules, age, old } = await normalLinkedDependencies();
      rmSync(modules, { recursive: true });
      const app = join(root, 'apps', 'mobile');
      const target = join(app, 'node_modules');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{}');
      writeFileSync(join(target, 'dependency.js'), 'installed');
      config.projects[app] = {};
      saveConfig(config);
      recordWorkspaceUse(app, old);
      const before = readGcMark(root);
      if (!before) throw new Error('fixture mark missing');
      delete before.dependencies;
      writeFileSync(gcMarkFile(root), JSON.stringify(before));
      age(roots);
      await lane(true);
      const observation = readGcMark(root)?.dependencies;
      expect(observation?.keys).toEqual(expect.arrayContaining([root, app]));
      mkdirSync(dirname(diskUsageCacheFile(target)), { recursive: true });
      writeFileSync(
        diskUsageCacheFile(target),
        JSON.stringify({
          path: target,
          bytes: 1024 ** 3,
          privateBytes: 1024 ** 3,
          measuredAt: new Date().toISOString(),
          signature: treeSignature(target),
        }),
      );
      const list = artifacts.artifactWorktreesFor;
      let changed = false;
      vi.spyOn(artifacts, 'artifactWorktreesFor').mockImplementation(async (operation) => {
        const worktrees = await list(operation);
        changed = true;
        delete config.projects[app];
        saveConfig(config);
        return worktrees;
      });

      const actions = await runDormantDependencies({
        config,
        act: true,
        marks: true,
        log: () => {},
        ...reading,
        operation: testContext(),
      });

      expect(changed).toBe(true);
      expect(actions).toContainEqual(expect.objectContaining({ target, outcome: 'kept' }));
      expect(existsSync(join(target, 'dependency.js'))).toBe(true);
      expect(readGcMark(root)?.dependencies).toEqual(observation);
      expect(config.projects[root]).toEqual({});
    }, 20_000);

    it('cleans an unregistered discovered linked dependency beside a definitively removed registration', async () => {
      const source = checkout('discovered-source', 3 * day);
      const root = join(roots, 'discovered-linked');
      execFileSync('git', [
        '-C',
        source,
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        'worktree',
        'add',
        '-q',
        '-b',
        'linked',
        root,
      ]);
      const modules = join(root, 'node_modules');
      mkdirSync(modules);
      writeFileSync(join(modules, 'dependency.js'), 'installed');
      const removed = checkout('removed-registration', 3 * day);
      config.projects[removed] = {};
      saveConfig(config);
      rmSync(removed, { recursive: true });
      const old = new Date(Date.now() - 3 * day);
      const age = (path: string) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) age(child);
          utimesSync(child, old, old);
        }
        utimesSync(path, old, old);
      };
      age(roots);
      await lane(true);
      expect(readGcMark(root)?.dependencies).toMatchObject({
        role: 'linked',
        candidates: [expect.objectContaining({ path: modules })],
      });
      expect(listedRoots()).not.toContain(root);
      expect(config.projects[root]).toBeUndefined();
      mkdirSync(dirname(diskUsageCacheFile(modules)), { recursive: true });
      writeFileSync(
        diskUsageCacheFile(modules),
        JSON.stringify({
          path: modules,
          bytes: 1024 ** 3,
          privateBytes: 1024 ** 3,
          measuredAt: new Date().toISOString(),
          signature: treeSignature(modules),
        }),
      );

      const actions = await runDormantDependencies({
        config,
        act: true,
        marks: true,
        log: () => {},
        ...reading,
        operation: testContext(),
      });

      expect(actions).toContainEqual(expect.objectContaining({ target: modules, outcome: 'done' }));
      expect(existsSync(modules)).toBe(false);
    }, 20_000);
  });

  const normalSourceDependencies = async () => {
    const root = checkout('normal-source-deps', 3 * day);
    const modules = join(root, 'node_modules');
    mkdirSync(modules);
    writeFileSync(join(modules, 'dependency.js'), 'installed');
    config.projects[root] = {};
    config.idle = { dormantDays: 0, sourceDormantDays: 1 };
    saveConfig(config);
    recordWorkspaceUse(root, new Date(Date.now() - 3 * day));
    const old = new Date(Date.now() - 3 * day);
    const age = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) age(child);
        utimesSync(child, old, old);
      }
      utimesSync(path, old, old);
    };
    age(roots);
    await lane(true);
    const cache = () => {
      mkdirSync(dirname(diskUsageCacheFile(modules)), { recursive: true });
      writeFileSync(
        diskUsageCacheFile(modules),
        JSON.stringify({
          path: modules,
          bytes: 1024 ** 3,
          privateBytes: 1024 ** 3,
          measuredAt: new Date().toISOString(),
          signature: treeSignature(modules),
        }),
      );
    };
    return { root, modules, age, old, cache };
  };

  describe.skipIf(process.platform === 'win32')('normal source dependency selection', () => {
    it('normal source dependencies select the saved paths and preserve a new unmarked tree', async () => {
      const { root, modules, age, cache } = await normalSourceDependencies();
      const before = readGcMark(root)?.dependencies;
      expect(before).toMatchObject({ role: 'source', candidates: [expect.objectContaining({ path: modules })] });
      const pods = join(root, 'ios', 'Pods');
      mkdirSync(pods, { recursive: true });
      writeFileSync(join(pods, 'new-pod'), 'new unmarked tree');
      age(roots);
      cache();
      vi.mocked(stat).mockClear();

      const actions = await runDormantDependencies({
        config,
        act: true,
        marks: true,
        log: () => {},
        ...reading,
        operation: testContext(),
      });

      expect(actions).toContainEqual(
        expect.objectContaining({
          kind: 'delete-dependencies',
          target: modules,
          outcome: 'done',
          setting: 'idle.sourceDormantDays',
        }),
      );
      expect(existsSync(modules)).toBe(false);
      expect(existsSync(join(pods, 'new-pod'))).toBe(true);
      expect(vi.mocked(stat).mock.calls.some(([path]) => String(path) === pods)).toBe(false);
      expect(readGcMark(root)?.dependencies).toEqual(before);
    }, 20_000);

    it.each(['missing', 'due', 'failed-publication'] as const)(
      'normal source dependencies publish a %s generation before selection',
      async (mode) => {
        const { root, modules, old, cache } = await normalSourceDependencies();
        const mark = readGcMark(root);
        if (!mark?.dependencies) throw new Error('fixture source observation missing');
        if (mode === 'due') mark.dependencies.markedAt = old.toISOString();
        else delete mark.dependencies;
        writeFileSync(gcMarkFile(root), JSON.stringify(mark));
        if (mode === 'failed-publication') vi.spyOn(cacheFiles, 'writeCacheFile').mockImplementation(() => {});
        cache();

        const actions = await runDormantDependencies({
          config,
          act: true,
          marks: true,
          log: () => {},
          ...reading,
          operation: testContext(),
        });

        expect(actions.some((action) => action.target === modules && action.outcome === 'done')).toBe(
          mode !== 'failed-publication',
        );
        expect(existsSync(modules)).toBe(mode === 'failed-publication');
        expect(readGcMark(root)?.dependencies?.markedAt).toBe(
          mode === 'failed-publication' ? undefined : new Date().toISOString(),
        );
      },
      20_000,
    );

    it.each(['warm', 'pin', 'sharing', 'setting'] as const)(
      'normal source dependencies preserve current %s protection after selection',
      async (change) => {
        const { root, modules, age, cache } = await normalSourceDependencies();
        cache();
        const list = artifacts.artifactWorktreesFor;
        let changed = false;
        vi.spyOn(artifacts, 'artifactWorktreesFor').mockImplementation(async (operation) => {
          const worktrees = await list(operation);
          changed = true;
          if (change === 'warm') recordWarmedFrom(root);
          else if (change === 'pin')
            writeFileSync(join(root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
          else if (change === 'setting') {
            config.idle = { dormantDays: 0, sourceDormantDays: 0 };
            saveConfig(config);
          } else {
            const linked = join(roots, 'new-sharing-worktree');
            execFileSync('git', [
              '-C',
              root,
              '-c',
              'maintenance.auto=false',
              '-c',
              'gc.auto=0',
              'worktree',
              'add',
              '-q',
              '-b',
              'sharing',
              linked,
            ]);
            symlinkSync(modules, join(linked, 'node_modules'), 'dir');
            age(roots);
          }
          return worktrees;
        });

        const actions = await runDormantDependencies({
          config,
          act: true,
          marks: true,
          log: () => {},
          ...reading,
          operation: testContext(),
        });

        expect(changed).toBe(true);
        expect(actions).toContainEqual(
          expect.objectContaining({ kind: 'delete-dependencies', target: modules, outcome: 'kept' }),
        );
        expect(actions.some(({ outcome }) => outcome === 'failed')).toBe(false);
        expect(existsSync(join(modules, 'dependency.js'))).toBe(true);
      },
      20_000,
    );
  });

  it('keeps the output generation and shared dirty watermark independent of dependency observations', async () => {
    const root = checkout('independent', 3 * day);
    const path = join(root, 'node_modules');
    mkdirSync(path);
    config.projects[root] = {};
    saveConfig(config);
    const initial = Date.now() - 20 * 60_000;
    const write = markWriter(config);
    await write({ path: root, at: initial, lastActivityAt: null, kept: null });
    const observe = dependencyMarkObserver(config, { ...reading, operation: testContext() }, async () => {});
    const inventory = (at: number) => ({
      worktree: { path: root, keys: [root], linked: false, locked: false, reduceOnly: false },
      at,
      complete: true,
      candidates: [{ candidate: { worktree: root, path, keys: [root], locked: false, reduceOnly: false }, keep: null }],
    });
    await observe(inventory(initial));
    const dirtyAt = new Date(initial + 1).toISOString();
    const cargoVia = [join(root, 'apps', 'mobile')];
    writeFileSync(gcMarkFile(root), JSON.stringify({ ...readGcMark(root), dirtyAt, cargoVia }));
    const outputAt = Date.now();
    await write({ path: root, at: outputAt, lastActivityAt: null, kept: null });
    expect(readGcMark(root)).toMatchObject({
      markedAt: new Date(outputAt).toISOString(),
      dirtyAt,
      cargoVia,
      dependencies: { markedAt: new Date(initial).toISOString() },
    });

    await observe(inventory(Date.now()));

    expect(readGcMark(root)).toMatchObject({
      markedAt: new Date(outputAt).toISOString(),
      cargoVia,
      dependencies: { markedAt: expect.not.stringMatching(new Date(initial).toISOString()) },
    });
    const dependencyAt = readGcMark(root)?.dependencies?.markedAt;
    await markWriter(
      config,
      undefined,
      false,
      new Map([[root, { roots: [], via: [] }]]),
    )({ path: root, at: outputAt + 1, lastActivityAt: null, kept: null });
    expect(readGcMark(root)?.cargoVia).toBeUndefined();
    expect(readGcMark(root)?.dependencies?.markedAt).toBe(dependencyAt);
  });

  it('omits malformed optional dependency evidence without invalidating existing output marks', async () => {
    const root = checkout('malformed-deps', 3 * day);
    await markWriter(config)({ path: root, at: Date.now(), lastActivityAt: null, kept: null });
    const original = readGcMark(root);
    writeFileSync(
      gcMarkFile(root),
      JSON.stringify({
        ...original,
        dependencies: {
          markedAt: new Date().toISOString(),
          role: 'source',
          keys: [root],
          candidates: [{ path: 'relative', device: 1, bytes: null, measuredAt: null }],
        },
      }),
    );
    expect(readGcMark(root)).toEqual(original);
    expect((await outputMarks({ ...config, projects: { [root]: {} } }, testContext()))[0]).toEqual(original);
  });

  it('reports known critical dependency evidence without a discovery, artifact collection or new mark', async () => {
    const root = checkout('saved-deps', 2 * 60 * 60_000);
    const path = join(root, 'node_modules');
    mkdirSync(path);
    config.projects[root] = {};
    config.idle = { dormantDays: 1, sourceDormantDays: 7 };
    saveConfig(config);
    await lane(true);
    const original = readGcMark(root);
    const discover = vi.spyOn(discovery, 'discoverCheckouts').mockRejectedValue(new Error('must not discover'));
    const collect = vi.spyOn(artifacts, 'collectArtifactsAsync').mockRejectedValue(new Error('must not collect'));

    const reports = await savedDependencyReports(config, {
      ...reading,
      level: 'critical',
      operation: testContext(),
      onVolume: () => true,
    });

    expect(reports).toEqual([expect.objectContaining({ rung: 8, target: path })]);
    expect(discover).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(readGcMark(root)).toEqual(original);
    recordWorkspaceUse(root, new Date());
    const recent = await savedDependencyReports(config, {
      ...reading,
      level: 'critical',
      operation: testContext(),
      onVolume: () => true,
    });
    expect(recent[0]?.detail).toContain('no longer idle');
  }, 20_000);

  it.each(['live', 'unavailable', 'owned'])(
    'keeps linked dependency reports when the process table is %s after observation',
    async (mode) => {
      const source = checkout('process-source', 2 * day);
      const linked = ['first', 'second'].map((name) => {
        const root = join(roots, name);
        execFileSync('git', [
          '-C',
          source,
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          'worktree',
          'add',
          '-q',
          '-b',
          name,
          root,
        ]);
        mkdirSync(join(root, 'node_modules'));
        config.projects[root] = {};
        recordWorkspaceUse(root, new Date(Date.now() - 2 * 60 * 60_000));
        return root;
      });
      const [first, second] = linked;
      if (!first || !second) throw new Error('fixture roots missing');
      saveConfig(config);
      await lane(true);
      const child =
        mode === 'live'
          ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: first, stdio: 'ignore' })
          : null;
      try {
        if (child) await once(child, 'spawn');
        if (mode === 'unavailable') vi.mocked(readRunningProcessesAsync).mockResolvedValueOnce(null);
        vi.mocked(readRunningProcessesAsync).mockClear();
        const reports = await savedDependencyReports(config, {
          ...reading,
          level: 'high',
          operation: testContext(),
          devices:
            mode === 'owned'
              ? [
                  {
                    kind: 'ios',
                    id: 'sim',
                    name: 'sim',
                    project: first,
                    slot: 'default',
                    activity: { state: 'idle', basis: [] },
                  },
                ]
              : [],
          onVolume: () => true,
        });
        const firstReport = reports.find(({ target }) => target === join(first, 'node_modules'));
        expect(firstReport?.detail).toContain(
          mode === 'owned'
            ? 'something of it runs'
            : mode === 'unavailable' || process.platform === 'win32'
              ? 'processes cannot be listed'
              : `process ${child?.pid}`,
        );
        expect(reports.find(({ target }) => target === join(second, 'node_modules'))?.detail).toMatch(
          mode !== 'unavailable' && process.platform !== 'win32'
            ? /^report only: deleting/
            : /processes cannot be listed/,
        );
        expect(vi.mocked(readRunningProcessesAsync)).toHaveBeenCalledTimes(1);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
          await once(child, 'close');
        }
        vi.mocked(readRunningProcessesAsync).mockReset();
      }
    },
    20_000,
  );

  it('does not let an unrelated removed registration suppress a healthy saved report', async () => {
    const root = checkout('healthy', 2 * day);
    const missing = checkout('removed', 2 * day);
    mkdirSync(join(root, 'node_modules'));
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(root, old, old);
    config.projects = { [root]: {}, [missing]: {} };
    config.idle = { dormantDays: 1, sourceDormantDays: 7 };
    recordWorkspaceUse(root, old);
    saveConfig(config);
    await lane(true);
    rmSync(missing, { recursive: true, force: true });

    const reports = await savedDependencyReports(config, {
      ...reading,
      level: 'critical',
      operation: testContext(),
      onVolume: () => true,
    });

    expect(reports.find(({ target }) => target === join(root, 'node_modules'))?.detail).toMatch(
      /^report only: deleting/,
    );
  }, 20_000);

  it('reports dirty empty inventories as unknown only after checking current root identity and device', async () => {
    const root = checkout('empty-inventory', 2 * day);
    config.projects[root] = {};
    config.idle = { dormantDays: 1, sourceDormantDays: 7 };
    saveConfig(config);
    await lane(true);
    const original = readGcMark(root);
    if (!original?.dependencies) throw new Error('fixture dependency observation missing');
    expect(original.dependencies.candidates).toEqual([]);
    const metadata = vi
      .spyOn(worktree, 'resolveSourceCheckoutAsync')
      .mockRejectedValue(new Error('empty observations need no eligibility read'));
    expect(
      await savedDependencyReports(config, {
        ...reading,
        level: 'critical',
        operation: testContext(),
        onVolume: () => true,
      }),
    ).toEqual([]);
    mkdirSync(join(root, 'node_modules'));
    const dirty = { ...original, dirtyAt: new Date(Date.parse(original.dependencies.markedAt) + 1).toISOString() };
    writeFileSync(gcMarkFile(root), JSON.stringify(dirty));
    expect(
      await savedDependencyReports(config, {
        ...reading,
        level: 'critical',
        operation: testContext(),
        onVolume: () => true,
      }),
    ).toEqual([expect.objectContaining({ target: root, detail: expect.stringContaining('due or dirty') })]);
    writeFileSync(gcMarkFile(root), JSON.stringify({ ...dirty, device: dirty.device + 1 }));
    expect(
      await savedDependencyReports(config, {
        ...reading,
        level: 'critical',
        operation: testContext(),
        onVolume: () => true,
      }),
    ).toEqual([expect.objectContaining({ target: root, detail: expect.stringContaining('changed volume') })]);
    expect(metadata).not.toHaveBeenCalled();
  }, 20_000);

  it('keeps source sharing unknown without scanning another worktree and retains a trusted cached estimate', async () => {
    const root = checkout('shared-source', 2 * 60 * 60_000);
    const path = join(root, 'node_modules');
    mkdirSync(path);
    const linked = join(roots, 'other-linked');
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      'worktree',
      'add',
      '-q',
      '-b',
      'other',
      linked,
    ]);
    config.projects[root] = {};
    config.idle = { dormantDays: 1, sourceDormantDays: 7 };
    saveConfig(config);
    await lane(true);
    mkdirSync(dirname(diskUsageCacheFile(path)), { recursive: true });
    writeFileSync(
      diskUsageCacheFile(path),
      JSON.stringify({
        path,
        bytes: 1024 ** 3,
        privateBytes: 512 * 1024 ** 2,
        measuredAt: new Date().toISOString(),
        signature: treeSignature(path),
      }),
    );

    const reports = await savedDependencyReports(config, {
      ...reading,
      level: 'critical',
      operation: testContext(),
      onVolume: () => true,
    });

    expect(reports).toEqual([
      expect.objectContaining({
        target: path,
        detail: expect.stringContaining('current sharing with linked worktrees is unproven'),
      }),
    ]);
    expect(reports[0]?.detail).toContain('512');
    expect(existsSync(path)).toBe(true);
  }, 20_000);

  it.each([
    ['a torn file', (root: string) => `{"v":1,"root":${JSON.stringify(root)},"cand`],
    ['an unknown version', (root: string) => JSON.stringify({ v: 99, root, candidates: [] })],
  ])(
    'reads %s as absent and replaces it with a fresh mark',
    async (_, text) => {
      const idle = checkout('idle', 3 * day);
      saveConfig(config);
      mkdirSync(dirname(gcMarkFile(idle)), { recursive: true });
      writeFileSync(gcMarkFile(idle), text(idle));
      expect(readGcMark(idle)).toBeNull();

      await lane(true);

      expect(readGcMark(idle)).toMatchObject({ v: GC_MARK_VERSION, root: idle, candidates: [{ kind: 'outputs' }] });
    },
    20_000,
  );

  it('keeps a dirtyAt that is newer than the reads of the mark, and drops an older one', async () => {
    const idle = checkout('idle', 3 * day);
    const other = checkout('other', 3 * day);
    saveConfig(config);
    const dirty = (root: string, dirtyAt: string) => {
      mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
      writeFileSync(
        gcMarkFile(root),
        JSON.stringify({
          v: GC_MARK_VERSION,
          root,
          device: 1,
          markedAt: dirtyAt,
          dirtyAt,
          lastActivityAt: null,
          candidates: [],
        }),
      );
    };
    const later = new Date(Date.now() + 60_000).toISOString();
    dirty(idle, later);
    dirty(other, new Date(Date.now() - 60_000).toISOString());

    const write = markWriter(config);
    for (const path of [idle, other]) await write({ path, at: Date.now(), lastActivityAt: null, kept: null });

    expect(readGcMark(idle)?.dirtyAt).toBe(later);
    expect(readGcMark(other)).not.toHaveProperty('dirtyAt');
  }, 20_000);

  it('marks registered checkouts with Metro stores and Cargo targets without a process read, with package reads linear and config reads constant in the count', async () => {
    vi.stubEnv('STIM_METRO_CACHE', undefined);
    const paths = Array.from({ length: 6 }, (_, i) => {
      const path = checkout(`app${i}`, 3 * day);
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name: `app${i}`, dependencies: { expo: '*' } }));
      mkdirSync(metroStoreRoot(path), { recursive: true });
      mkdirSync(join(path, 'target', 'debug'), { recursive: true });
      writeFileSync(join(path, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
      return path;
    });
    const mark = async (count: number) => {
      const marked = paths.slice(0, count);
      const registered = { ...config, projects: Object.fromEntries(marked.map((path) => [path, {}])) };
      saveConfig(registered);
      vi.mocked(readRunningProcessesAsync).mockClear();
      reads.packages = 0;
      reads.configs = 0;
      const write = markWriter(registered);
      for (const path of marked) await write({ path, at: Date.now(), lastActivityAt: null, kept: null });
      return {
        processReads: vi.mocked(readRunningProcessesAsync).mock.calls.length,
        packageReads: reads.packages,
        configReads: reads.configs,
      };
    };

    const few = await mark(3);
    const many = await mark(6);

    expect(readGcMark(paths[5] ?? '')?.candidates.map(({ kind, path }) => [kind, path])).toEqual([
      ['outputs', join(paths[5] ?? '', 'android', 'app', 'build')],
      ['cargo-target', join(paths[5] ?? '', 'target')],
      ['outputs', metroStoreRoot(paths[5] ?? '')],
    ]);
    expect(few.processReads).toBe(0);
    expect(many.processReads).toBe(0);
    expect(many.packageReads).toBe(2 * few.packageReads);
    expect(many.configReads).toBeLessThanOrEqual(few.configReads);
  }, 20_000);
});
