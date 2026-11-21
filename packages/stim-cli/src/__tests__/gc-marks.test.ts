import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diskUsageCacheFile, gcMarkFile, readGcMark, type Config } from '@stim-cli/core/state';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { markWriter } from '../daemon/marks.ts';
import { stoppedOutputCandidates, stoppedOutputs } from '../daemon/stages.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import { saveConfig } from '../workspace/config.ts';
import { readRunningProcessesAsync } from '../workspace/running-from.ts';
import { hungRead, pendingRead, Unanswered } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: vi.fn<typeof fs.lstat>(fs.lstat), stat: vi.fn<typeof fs.stat>(fs.stat) };
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
      execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      });
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
    expect(mark?.candidates).toEqual([{ kind: 'outputs', path: build, bytes: 4096, measuredAt }]);
    expect(Date.parse(mark?.lastActivityAt ?? '')).toBeLessThanOrEqual(Date.now() - 3 * day);

    const busy = readGcMark(active);
    expect(busy?.candidates).toEqual([
      { kind: 'outputs', path: join(active, 'android', 'app', 'build'), bytes: null, measuredAt: null },
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
        v: 1,
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

  it.each([
    ['a torn file', (root: string) => `{"v":1,"root":${JSON.stringify(root)},"cand`],
    ['an unknown version', (root: string) => JSON.stringify({ v: 2, root, candidates: [] })],
  ])(
    'reads %s as absent and replaces it with a fresh mark',
    async (_, text) => {
      const idle = checkout('idle', 3 * day);
      saveConfig(config);
      mkdirSync(dirname(gcMarkFile(idle)), { recursive: true });
      writeFileSync(gcMarkFile(idle), text(idle));
      expect(readGcMark(idle)).toBeNull();

      await lane(true);

      expect(readGcMark(idle)).toMatchObject({ v: 1, root: idle, candidates: [{ kind: 'outputs' }] });
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
        JSON.stringify({ v: 1, root, device: 1, markedAt: dirtyAt, dirtyAt, lastActivityAt: null, candidates: [] }),
      );
    };
    const later = new Date(Date.now() + 60_000).toISOString();
    dirty(idle, later);
    dirty(other, new Date(Date.now() - 60_000).toISOString());

    await lane(true);

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
