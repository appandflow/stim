import { lstat, readdir } from 'node:fs/promises';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listBuildEndMarkers, newBuildEndMarkerFile } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { markBuildEnded } from '../build-end-marker.ts';
import { writeCacheFile } from '../cache-file.ts';
import { INSTALL_MARKERS, installSignature } from '../private-size.ts';
import { measureBuildEnds, measureDependencyTrees } from '../daemon/dependencies.ts';
import { forgetStatusMeasures } from '../status-measures.ts';
import { startBuildEndTimer } from '../stimd/build-end-timer.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir } from '../workspace/paths.ts';
import type { CensusIo } from '../workspace/discovery-census.ts';

const state = vi.hoisted(() => {
  const value: {
    calls: { path: string; private: boolean | undefined; known: boolean | undefined; signature: string | undefined }[];
    outcome: 'measured' | 'busy';
    during: () => void;
    io: CensusIo | null;
    worktree: string;
    platform: NodeJS.Platform | undefined;
  } = { calls: [], outcome: 'measured', during: () => {}, io: null, platform: undefined, worktree: '' };
  return value;
});
vi.mock('../disk-usage.ts', async (original) => ({
  ...(await original<typeof import('../disk-usage.ts')>()),
  refreshMeasure: async (path: string, options: { private?: boolean; knownToExist?: true; signature?: string }) => {
    state.calls.push({ path, private: options.private, known: options.knownToExist, signature: options.signature });
    state.during();
    return { outcome: state.outcome, measure: null };
  },
}));
vi.mock('../stimd/passes/artifacts.ts', async (original) => ({
  ...(await original<typeof import('../stimd/passes/artifacts.ts')>()),
  artifactWorktreesAsync: async () => [{ path: state.worktree, keys: [] }],
}));
vi.mock('../workspace/discovery-census.ts', async (original) => {
  const real = await original<typeof import('../workspace/discovery-census.ts')>();
  return {
    ...real,
    buildOutputDirs: (root: string, signal: AbortSignal) =>
      real.buildOutputDirs(root, signal, {
        ...(state.io ? { io: state.io } : {}),
        ...(state.platform ? { platform: state.platform } : {}),
      }),
    dependencyDirsOf: (root: string, signal: AbortSignal) =>
      real.dependencyDirsOf(root, signal, state.io ? { io: state.io } : {}),
  };
});

let base: string;
let app: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-build-end-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  app = join(base, 'app');
  mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
  writeFileSync(join(app, 'android', 'app', 'build', 'x'), 'x');
  upsertProject(app, {});
  state.calls = [];
  state.outcome = 'measured';
  state.during = () => {};
  state.io = null;
  state.worktree = app;
  state.platform = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const operation = () => testContext({ home: join(base, 'home'), projectRoot: app, cwd: app });
const walked = () => state.calls.map((call) => call.path);

it('measures a marked workspace once and removes only the marks it listed', async () => {
  markBuildEnded(app);
  state.during = () => {
    if (listBuildEndMarkers().length === 1) markBuildEnded(app);
  };
  await measureBuildEnds(operation());
  expect(walked()).toContain(join(app, 'android', 'app', 'build'));
  expect(listBuildEndMarkers()).toHaveLength(1);
  state.during = () => {};
  await measureBuildEnds(operation());
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('keeps every marker while the walk claim is held', async () => {
  markBuildEnded(app);
  state.outcome = 'busy';
  await measureBuildEnds(operation());
  expect(listBuildEndMarkers()).toHaveLength(1);
});

it('drops the marker of a workspace that no longer exists, walking nothing', async () => {
  markBuildEnded(app);
  rmSync(app, { recursive: true, force: true });
  await measureBuildEnds(operation());
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('drops a marker for a root this Stim home does not know without reading inside it', async () => {
  const stranger = join(base, 'stranger');
  mkdirSync(join(stranger, 'android', 'app', 'build'), { recursive: true });
  markBuildEnded(stranger);
  await measureBuildEnds(operation());
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('removes a marker that cannot be read or whose name does not match its path', async () => {
  writeCacheFile(newBuildEndMarkerFile(join(base, 'one')), { path: join(base, 'two') });
  writeFileSync(newBuildEndMarkerFile(app), '{not json');
  expect(listBuildEndMarkers().map((marker) => marker.path)).toEqual([null, null]);
  await measureBuildEnds(operation());
  expect(listBuildEndMarkers()).toEqual([]);
});

it('walks the build folders of the workspace with the private flag the gc report expects, and its Stim folder', async () => {
  mkdirSync(join(app, 'android', '.cxx'), { recursive: true });
  mkdirSync(join(app, '.dd', 'Build', 'Products'), { recursive: true });
  mkdirSync(join(app, '.dd', 'Logs'), { recursive: true });
  writeFileSync(join(app, 'exact.mjs'), '');
  mkdirSync(join(app, 'target'), { recursive: true });
  markBuildEnded(app);
  await measureBuildEnds(operation());
  const byPath = new Map(state.calls.map((call) => [call.path, call]));
  expect(byPath.get(join(app, 'android', 'app', 'build'))).toMatchObject({ private: false, known: true });
  for (const dir of ['android/.cxx', '.dd', 'target'])
    expect(byPath.get(join(app, dir))).toMatchObject({ private: true, known: true });
  expect(byPath.get(workspaceDir(app))).toMatchObject({ private: false });
  expect(walked()).toHaveLength(5);
});

it('leaves out a build folder reached through a link to another checkout', async () => {
  const other = join(base, 'other');
  mkdirSync(join(other, 'android', 'app', 'build'), { recursive: true });
  rmSync(join(app, 'android'), { recursive: true, force: true });
  symlinkSync(join(other, 'android'), join(app, 'android'));
  markBuildEnded(app);
  await measureBuildEnds(operation());
  expect(walked()).toEqual([workspaceDir(app)]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('keeps the marker and measures nothing when the layout of the workspace cannot be read', async () => {
  state.io = {
    readNames: async () => [],
    isDirectory: async () => false,
    lstat: async () => ({ kind: 'other', mtimeMs: 0 }),
    realpath: async () => {
      throw Object.assign(new Error('input/output error'), { code: 'EIO' });
    },
    head: async () => null,
  };
  markBuildEnded(app);
  await measureBuildEnds(operation());
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(1);
});

it('drops a marker older than an hour without reading the workspace', async () => {
  markBuildEnded(app);
  await measureBuildEnds(operation(), Date.now() + 61 * 60_000);
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it.each([
  ['darwin', true],
  ['win32', true],
  ['linux', false],
] as const)('on %s a root spelled with another case than its canonical path is walked: %s', async (platform, walks) => {
  const canonical = join(base, 'APP');
  const respell = (path: string) => (path.startsWith(app) ? canonical + path.slice(app.length) : path);
  state.platform = platform;
  state.io = {
    readNames: (path) => readdir(path),
    isDirectory: async (path) => (await lstat(path)).isDirectory(),
    lstat: async (path) => {
      const info = await lstat(path);
      return { kind: info.isDirectory() ? 'directory' : 'file', mtimeMs: info.mtimeMs };
    },
    realpath: async (path) => respell(path),
    head: async () => null,
  };
  markBuildEnded(app);
  await measureBuildEnds(operation());
  expect(walked().includes(join(app, 'android', 'app', 'build'))).toBe(walks);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('does not walk a root that is a link to a sibling differing only by case', async () => {
  state.platform = 'darwin';
  state.io = {
    readNames: async () => [],
    isDirectory: async () => false,
    lstat: async () => ({ kind: 'other', mtimeMs: 0 }),
    realpath: async (path) => path.replace(/app$/, 'APP'),
    head: async () => null,
  };
  markBuildEnded(app);
  await measureBuildEnds(operation());
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

it('does not walk a registered root that a link has replaced', async () => {
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(elsewhere, 'android', 'app', 'build'), { recursive: true });
  markBuildEnded(app);
  rmSync(app, { recursive: true, force: true });
  symlinkSync(elsewhere, app);
  await measureBuildEnds(operation());
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(0);
});

function stalledIo(): { io: CensusIo; release: () => void } {
  const waiting: (() => void)[] = [];
  const stall = <T>(value: T) => new Promise<T>((done) => waiting.push(() => done(value)));
  return {
    io: {
      readNames: () => stall([]),
      isDirectory: () => stall(false),
      lstat: () => stall({ kind: 'other' as const, mtimeMs: 0 }),
      realpath: () => stall(app),
      head: () => stall(null),
    },
    release: () => waiting.forEach((done) => done()),
  };
}

it('ends the pass and keeps the marker when a read of the workspace does not answer', async () => {
  vi.useFakeTimers();
  const stalled = stalledIo();
  state.io = stalled.io;
  markBuildEnded(app);
  const pass = measureBuildEnds(operation());
  await vi.advanceTimersByTimeAsync(3000);
  await pass;
  expect(walked()).toEqual([]);
  expect(listBuildEndMarkers()).toHaveLength(1);
  stalled.release();
  await vi.advanceTimersByTimeAsync(0);
});

it('measures the dependency trees that answer, and none when a read does not', async () => {
  mkdirSync(join(app, 'node_modules'));
  await measureDependencyTrees(operation());
  expect(walked()).toEqual([join(app, 'node_modules')]);

  state.calls = [];
  vi.useFakeTimers();
  const stalled = stalledIo();
  state.io = stalled.io;
  const pass = measureDependencyTrees(operation());
  await vi.advanceTimersByTimeAsync(3000);
  await pass;
  expect(walked()).toEqual([]);
  stalled.release();
  await vi.advanceTimersByTimeAsync(0);
});

it('still measures a readable dependency tree when its sibling cannot be read', async () => {
  mkdirSync(join(app, 'node_modules'));
  mkdirSync(join(app, 'ios', 'Pods'), { recursive: true });
  const unreadable = (path: string) => path.endsWith(join('ios', 'Pods'));
  const eio = Object.assign(new Error('input/output error'), { code: 'EIO' });
  state.io = {
    readNames: (path) => readdir(path),
    isDirectory: async (path) => {
      if (unreadable(path)) throw eio;
      return (await lstat(path)).isDirectory();
    },
    realpath: async (path) => path,
    head: async () => null,
    lstat: async (path) => {
      if (unreadable(path)) throw eio;
      const info = await lstat(path);
      return { kind: info.isDirectory() ? 'directory' : 'file', mtimeMs: info.mtimeMs, ino: info.ino };
    },
  };
  await measureDependencyTrees(operation());
  expect(walked()).toEqual([join(app, 'node_modules')]);
});

it('still measures a dependency tree whose install marker cannot be read, with that marker counted missing', async () => {
  const tree = join(app, 'node_modules');
  mkdirSync(tree);
  writeFileSync(join(tree, '.package-lock.json'), '{}');
  const eio = Object.assign(new Error('input/output error'), { code: 'EIO' });
  state.io = {
    readNames: (path) => readdir(path),
    isDirectory: async (path) => (await lstat(path)).isDirectory(),
    realpath: async (path) => path,
    head: async () => null,
    lstat: async (path) => {
      if (path.endsWith('.package-lock.json')) throw eio;
      const info = await lstat(path);
      return { kind: info.isDirectory() ? 'directory' : 'file', mtimeMs: info.mtimeMs, ino: info.ino };
    },
  };
  await measureDependencyTrees(operation());
  const root = lstatSync(tree);
  expect(state.calls.map((call) => [call.path, call.signature])).toEqual([
    [
      tree,
      installSignature(
        `${root.ino}:${root.mtimeMs}`,
        INSTALL_MARKERS.map(() => null),
      ),
    ],
  ]);
});

it('settles an aborted pass during a stalled discovery and keeps the marker', async () => {
  vi.useFakeTimers();
  const stalled = stalledIo();
  state.io = stalled.io;
  markBuildEnded(app);
  const controller = new AbortController();
  const pass = measureBuildEnds({ ...operation(), signal: controller.signal });
  const outcome = pass.then(
    () => 'finished',
    (error: Error) => error.name,
  );
  controller.abort();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await outcome).toBe('AbortError');
  expect(listBuildEndMarkers()).toHaveLength(1);
  stalled.release();
  await vi.advanceTimersByTimeAsync(0);
});

it('clears the markers of a removed worktree and leaves other workspaces alone', () => {
  const other = join(base, 'other');
  markBuildEnded(app);
  markBuildEnded(app);
  markBuildEnded(other);
  forgetStatusMeasures(app, []);
  expect(listBuildEndMarkers().map((marker) => marker.path)).toEqual([other]);
});

it('starts no second job while one runs, and none for a closing daemon', async () => {
  vi.useFakeTimers();
  let busy = false;
  let allowed = true;
  const start = vi.fn<() => Promise<void>>(async () => {
    busy = true;
    await Promise.resolve();
    busy = false;
  });
  const stop = startBuildEndTimer({
    periodMs: 30_000,
    allowed: () => allowed,
    busy: () => busy,
    markers: () => [],
    start,
  });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(start).not.toHaveBeenCalled();
  stop();
  const markers = ['a'];
  const again = startBuildEndTimer({
    periodMs: 30_000,
    allowed: () => allowed,
    busy: () => true,
    markers: () => markers,
    start,
  });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(start).not.toHaveBeenCalled();
  again();
  allowed = false;
  const closing = startBuildEndTimer({
    periodMs: 30_000,
    allowed: () => allowed,
    busy: () => busy,
    markers: () => markers,
    start,
  });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(start).not.toHaveBeenCalled();
  closing();
});

it('backs off while passes leave their markers and resets after one that consumed them', async () => {
  vi.useFakeTimers();
  let markers = ['a'];
  const began = Date.now();
  const starts: number[] = [];
  const stop = startBuildEndTimer({
    periodMs: 30_000,
    allowed: () => true,
    busy: () => false,
    markers: () => markers,
    start: async () => {
      starts.push(Date.now() - began);
      if (starts.length === 4) markers = [];
    },
  });
  await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 240_000);
  expect(starts).toEqual([30_000, 90_000, 210_000, 450_000]);
  markers = ['b'];
  await vi.advanceTimersByTimeAsync(30_000);
  expect(starts).toHaveLength(5);
  stop();
});
