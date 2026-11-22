import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gcMarkFile, GC_MARK_VERSION, type Config, type GcMark } from '@stim-cli/core/state';
import { outputMarkBatch, outputMarks } from '../daemon/marks.ts';
import { readMarkHealth } from '../daemon/mark-health.ts';
import { hungRead, pendingRead } from '../workspace/bounded-read.ts';
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
    markedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    candidates: [],
  };
  mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
  writeFileSync(gcMarkFile(root), JSON.stringify(mark));
  return mark;
}

test('shared batch reads each mark once and preserves the sweep subset around malformed legacy state', async () => {
  const valid = record();
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
  expect(observed.roots).toEqual([{ root, device: 1 }]);
});

test('a missing mark directory reports unavailable instead of zero', async () => {
  const observed = await readMarkHealth(config, testContext());
  expect(observed.roots).toBeNull();
  expect(observed.marks).toEqual({
    at: Date.now(),
    state: 'unavailable',
    stale: [],
  });
});

test('a blocked inventory times out without starting another read and remains unavailable', async () => {
  record();
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
