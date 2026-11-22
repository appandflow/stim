import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gcMarkFile, GC_MARK_VERSION, type Config, type GcMark } from '@stim-cli/core/state';
import { outputMarkBatch, outputMarks } from '../daemon/marks.ts';
import { readMarkHealth } from '../daemon/mark-health.ts';
import { hungRead, pendingRead, Unanswered } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn<typeof fs.readFile>(fs.readFile), readdir: vi.fn<typeof fs.readdir>(fs.readdir) };
});

let base: string;
let root: string;
let config: Config;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-mark-inventory-')));
  root = join(base, 'project');
  mkdirSync(root);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  config = { projects: { [root]: {} }, repos: {} };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
function record(): GcMark {
  const mark: GcMark = {
    v: GC_MARK_VERSION,
    root,
    device: 1,
    markedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    candidates: [],
  };
  mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
  writeFileSync(gcMarkFile(root), JSON.stringify(mark));
  return mark;
}

test('shared batch reads each mark once and preserves the sweep subset around malformed legacy state', async () => {
  const valid = record();
  valid.candidates = [{ kind: 'outputs', path: join(root, 'build'), device: 1, bytes: 1, measuredAt: valid.markedAt }];
  writeFileSync(gcMarkFile(root), JSON.stringify(valid));
  const torn = join(dirname(gcMarkFile(root)), 'torn.json');
  writeFileSync(torn, '{');
  const legacy = gcMarkFile(join(base, 'legacy'));
  writeFileSync(legacy, JSON.stringify({ ...valid, root: join(base, 'legacy'), v: 1 }));
  const nullRecord = join(dirname(gcMarkFile(root)), 'null.json');
  writeFileSync(nullRecord, 'null');
  vi.mocked(readFile).mockClear();
  const batch = await outputMarkBatch(config, testContext());
  expect(batch).toEqual({ marks: [valid], complete: false, listed: true });
  for (const path of [gcMarkFile(root), torn, legacy, nullRecord])
    expect(vi.mocked(readFile).mock.calls.filter(([file]) => String(file) === path)).toHaveLength(1);
  expect(await outputMarks(config, testContext())).toEqual([valid]);
  const observed = await readMarkHealth(config, testContext());
  expect(observed.marks).toMatchObject({ state: 'partial', stale: [{ root }] });
  expect(observed.marks.candidates?.outputs).toEqual({
    state: 'partial',
    count: 1,
    knownBytes: 1,
    unknownSizeCount: 0,
    oldestMarkedAt: valid.markedAt,
  });
  expect(observed.roots).toEqual([{ root, device: 1 }]);
});

test('a missing mark directory reports unavailable instead of zero', async () => {
  const observed = await readMarkHealth(config, testContext());
  expect(observed.roots).toBeNull();
  expect(observed.marks).toEqual({
    at: Date.now(),
    state: 'unavailable',
    stale: [],
    candidates: {
      readState: 'unavailable',
      outputs: { state: 'unavailable' },
      dependencies: { state: 'unavailable' },
      worktrees: { state: 'unavailable' },
    },
  });
});

test('a blocked inventory times out without starting another read and remains unavailable', async () => {
  record();
  config.projects = {};
  let release: (files: never[]) => void = () => {};
  const lookup = vi.mocked(readdir).mockImplementationOnce(
    () =>
      new Promise<never[]>((resolve) => {
        release = resolve;
      }),
  );
  const work = readMarkHealth(config, testContext());
  try {
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith(dirname(gcMarkFile(root))));
    await vi.advanceTimersByTimeAsync(3000);
    const observed = await work;
    expect(observed.marks).toMatchObject({ state: 'unavailable' });
    expect(observed.roots).toBeNull();
    expect(hungRead()).toBe(dirname(gcMarkFile(root)));
  } finally {
    release([]);
    await pendingRead();
  }
});

test('cancellation propagates from an inventory read and settles its bounded read slot', async () => {
  record();
  let release: (files: never[]) => void = () => {};
  const lookup = vi.mocked(readdir).mockImplementationOnce(
    () =>
      new Promise<never[]>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const result = readMarkHealth(config, testContext({ signal: controller.signal })).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith(dirname(gcMarkFile(root))));
    const reason = new Error('cancel inventory');
    controller.abort(reason);
    expect(await result).toBe(reason);
  } finally {
    release([]);
    await pendingRead();
  }
});

test('an unanswered inventory propagates through registered scope checks to the owning daemon', async () => {
  record();
  let release: (files: never[]) => void = () => {};
  const lookup = vi.mocked(readdir).mockImplementationOnce(
    () =>
      new Promise<never[]>((resolve) => {
        release = resolve;
      }),
  );
  const result = readMarkHealth(config, testContext()).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith(dirname(gcMarkFile(root))));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeInstanceOf(Unanswered);
    expect(hungRead()).toBe(dirname(gcMarkFile(root)));
  } finally {
    release([]);
    await pendingRead();
  }
});

test('explicitly disabled discovery excludes old unregistered marks without claiming incomplete coverage', async () => {
  const valid = record();
  const excluded = join(base, 'excluded');
  mkdirSync(excluded);
  writeFileSync(gcMarkFile(excluded), JSON.stringify({ ...valid, root: excluded }));
  config.maintenance = { autoDiscover: false, discoverRoots: [] };
  expect(await outputMarkBatch(config, testContext())).toEqual({ marks: [valid], complete: true, listed: true });
});

test('candidate coverage uses the same authorized file batch and cached subtype evidence without reading candidate trees', async () => {
  const saved = record();
  const dependencyAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const worktreeAt = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const observed: GcMark = {
    ...saved,
    candidates: [
      { kind: 'outputs', path: join(root, 'build'), device: 1, bytes: 0, measuredAt: saved.markedAt },
      { kind: 'cargo-target', path: join(root, 'target'), device: 1, bytes: null, measuredAt: null },
    ],
    worktree: {
      markedAt: worktreeAt,
      source: base,
      head: 'abc',
      keys: [root],
      clean: true,
      pushed: true,
      finished: null,
      emptyBranch: false,
      activity: null,
      lastUsedAt: null,
      keep: { code: 'active', reason: 'kept', eligibleAt: null },
    },
    dependencies: {
      markedAt: dependencyAt,
      role: 'linked',
      keys: [root],
      candidates: [
        {
          path: join(root, 'node_modules'),
          device: 1,
          bytes: 7,
          measuredAt: dependencyAt,
          keep: { reason: 'active', at: dependencyAt },
        },
      ],
    },
  };
  writeFileSync(gcMarkFile(root), JSON.stringify(observed));
  const excluded = join(base, 'excluded');
  mkdirSync(excluded);
  writeFileSync(
    gcMarkFile(excluded),
    JSON.stringify({
      ...observed,
      root: excluded,
      candidates: [
        { kind: 'outputs', path: join(excluded, 'build'), device: 1, bytes: 999, measuredAt: saved.markedAt },
      ],
    }),
  );
  config.maintenance = { autoDiscover: false, discoverRoots: [] };
  vi.mocked(readFile).mockClear();
  vi.mocked(readdir).mockClear();
  const result = await readMarkHealth(config, testContext());
  expect(result.marks.candidates).toEqual({
    readState: 'ready',
    outputs: { state: 'ready', count: 2, knownBytes: 0, unknownSizeCount: 1, oldestMarkedAt: saved.markedAt },
    dependencies: { state: 'ready', count: 1, knownBytes: 7, unknownSizeCount: 0, oldestMarkedAt: dependencyAt },
    worktrees: { state: 'ready', count: 1, knownBytes: 0, unknownSizeCount: 1, oldestMarkedAt: worktreeAt },
  });
  expect(
    vi
      .mocked(readFile)
      .mock.calls.map(([path]) => String(path))
      .toSorted(),
  ).toEqual([gcMarkFile(root), gcMarkFile(excluded)].toSorted());
  expect(vi.mocked(readdir).mock.calls.map(([path]) => String(path))).toEqual([dirname(gcMarkFile(root))]);
});
