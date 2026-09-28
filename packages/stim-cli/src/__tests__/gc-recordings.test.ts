import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRecordingsDir } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpHome: string;
let projects: string;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) => (file === 'git' ? real.runFileQuiet(file, args, opts) : null),
    findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.exitCode = 0;
});

async function gcJson(opts: Parameters<typeof runGc>[0]) {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runGc({ ...opts, json: true });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? '');
}

/** Writes 1000-byte segments of one simulator's footage, each `[start, end]` in epoch milliseconds. */
function record(root: string, segments: [number, number][]): string {
  ensureWorkspaceStorage(root);
  const dir = join(workspaceRecordingsDir(root), 'ios-default');
  mkdirSync(dir, { recursive: true });
  for (const [start, end] of segments) writeFileSync(join(dir, `${start}-${end}.seg`), 'x'.repeat(1000));
  return dir;
}

function liveWorkspace(name: string, segments: [number, number][]): { root: string; dir: string } {
  const root = join(projects, name);
  mkdirSync(root);
  upsertProject(root, { metroPort: 8100, platforms: {} });
  return { root, dir: record(root, segments) };
}

const now = Date.now();

test('a plain gc lists recordings with their sizes, and deletes only those of a gone workspace', async () => {
  const live = liveWorkspace('live', [
    [now - 60_000, now - 30_000],
    [now - 30_000, now],
  ]);
  const gone = join(projects, 'gone');
  const goneDir = record(gone, [[now - 60_000, now]]);

  const report = await gcJson({});
  expect(report.sections.recordings).toEqual([
    expect.objectContaining({
      projectRoot: gone,
      bytes: 1000,
      deleteBytes: 1000,
      willDelete: true,
      withWorkspace: true,
      reason: null,
    }),
    expect.objectContaining({
      projectRoot: live.root,
      bytes: 2000,
      deleteBytes: 0,
      willDelete: false,
      withWorkspace: false,
      reason: 'retained',
    }),
  ]);
  expect(existsSync(goneDir)).toBe(true);

  await gcJson({ delete: true });
  expect(existsSync(goneDir)).toBe(false);
  expect(existsSync(join(live.dir, `${now - 30_000}-${now}.seg`))).toBe(true);
});

test('--cache recordings selects only the recordings, and --delete removes them whole', async () => {
  const live = liveWorkspace('live', [[now - 60_000, now]]);

  const report = await gcJson({ cache: 'recordings' });
  expect(report.cacheScope).toBe('recordings');
  expect(report.sections.caches).toEqual([]);
  expect(report.sections.workspaceBuildOutputs).toEqual([]);
  expect(report.sections.recordings).toEqual([
    expect.objectContaining({ projectRoot: live.root, bytes: 1000, deleteBytes: 1000, willDelete: true }),
  ]);
  expect(existsSync(live.dir)).toBe(true);

  const deleted = await gcJson({ cache: 'recordings', delete: true });
  expect(deleted.results).toEqual([expect.objectContaining({ kind: 'recording', status: 'done', bytes: 1000 })]);
  expect(existsSync(workspaceRecordingsDir(live.root))).toBe(false);
  expect(existsSync(join(workspaceRecordingsDir(live.root), '..', 'workspace.json'))).toBe(true);
});

test('--older-than deletes only the footage recorded before it', async () => {
  const live = liveWorkspace('live', [
    [now - 10 * DAY_MS, now - 10 * DAY_MS + 60_000],
    [now - 60_000, now],
  ]);

  const report = await gcJson({ olderThan: 7 });
  expect(report.sections.recordings).toEqual([
    expect.objectContaining({ bytes: 2000, deleteBytes: 1000, willDelete: true }),
  ]);

  await gcJson({ olderThan: 7, delete: true });
  expect(existsSync(join(live.dir, `${now - 10 * DAY_MS}-${now - 10 * DAY_MS + 60_000}.seg`))).toBe(false);
  expect(existsSync(join(live.dir, `${now - 60_000}-${now}.seg`))).toBe(true);
});

test('keeps the recordings of a workspace whose project root cannot be proven gone', async () => {
  const unmounted = join('/Volumes', `stim-test-unmounted-${process.pid}`, 'app');
  const dir = record(unmounted, [[now - 60_000, now]]);

  const report = await gcJson({});
  expect(report.sections.recordings).toEqual([]);
  expect(report.sections.skipped).toEqual([
    expect.objectContaining({ detail: expect.stringContaining('is not mounted') }),
  ]);

  await gcJson({ delete: true });
  await gcJson({ cache: 'recordings', delete: true });
  expect(existsSync(dir)).toBe(true);
});
