import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gcMarkFile, readGcMark, GC_MARK_VERSION, type Config, type GcMark } from '@stim-cli/core/state';
import * as stages from '../daemon/stages.ts';
import * as discovery from '../workspace/discovery.ts';
import { refreshKnownOutputMark } from '../daemon/mark-refresh.ts';
import { hungRead, pendingRead } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, stat: vi.fn<typeof fs.stat>(fs.stat) };
});

const minute = 60_000;
const day = 24 * 60 * minute;
let base: string;
let root: string;
let output: string;
let config: Config;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(stat).mockImplementation(actual.stat);
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-mark-refresh-')));
  root = join(base, 'app');
  output = join(root, 'target');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  writeFileSync(join(output, '.rustc_info.json'), '{}');
  writeFileSync(join(output, 'artifact'), 'keep');
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  config = { projects: { [root]: {} }, repos: {}, idle: { dormantDays: 7 } };
  vi.spyOn(discovery, 'discoverCheckouts').mockRejectedValue(new Error('refresh must not run discovery'));
  vi.spyOn(stages, 'readCheckout').mockImplementation(async (path) => ({
    path,
    at: Date.now(),
    lastActivityAt: Date.now(),
    kept: null,
  }));
});
afterEach(async () => {
  await pendingRead();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
function save(elapsed: number, activityAge: number | null, dirty = false): string {
  const now = Date.now();
  const mark: GcMark = {
    v: GC_MARK_VERSION,
    root,
    device: 1,
    markedAt: new Date(now - elapsed).toISOString(),
    lastActivityAt: activityAge === null ? null : new Date(now - activityAge).toISOString(),
    ...(dirty ? { dirtyAt: new Date(now - 1).toISOString() } : {}),
    candidates: [],
  };
  mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
  const text = JSON.stringify(mark);
  writeFileSync(gcMarkFile(root), text);
  return text;
}
const refresh = (signal = new AbortController().signal) =>
  refreshKnownOutputMark(config, root, {}, { devices: [], simsFailed: false, operation: testContext({ signal }) });

test.each([
  { age: 0, interval: 10 * minute, dirty: false },
  { age: null, interval: 10 * minute, dirty: false },
  { age: 2 * day, interval: 60 * minute, dirty: false },
  { age: 8 * day, interval: day, dirty: false },
  { age: 8 * day, interval: 10 * minute, dirty: true },
])('refreshes only at the generation boundary: $age dirty=$dirty', async ({ age, interval, dirty }) => {
  const before = save(interval - 1, age, dirty);
  await refresh();
  expect(stages.readCheckout).not.toHaveBeenCalled();
  expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  await refresh();
  expect(stages.readCheckout).toHaveBeenCalledTimes(1);
  expect(readGcMark(root)?.candidates).toContainEqual(expect.objectContaining({ kind: 'cargo-target', path: output }));
  expect(readFileSync(join(output, 'artifact'), 'utf8')).toBe('keep');
  expect(discovery.discoverCheckouts).not.toHaveBeenCalled();
});

test('the whole-root budget aborts activity reads and awaits their cleanup without replacing the previous mark', async () => {
  const before = save(day, 0);
  let release = () => {};
  let signal: AbortSignal | undefined;
  vi.mocked(stages.readCheckout).mockImplementationOnce(
    (_path, _project, reading) =>
      new Promise((_resolve, reject) => {
        signal = reading.operation?.signal;
        release = () => reject(signal?.reason);
      }),
  );
  let settled = false;
  const work = refresh().finally(() => {
    settled = true;
  });
  const result = work.catch((error: unknown) => error);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await vi.advanceTimersByTimeAsync(3000);
  expect(signal?.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
  release();
  expect(await result).toMatchObject({ message: 'mark read deadline' });
  expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
});

test('cancelling a pending layout read keeps the complete old generation after the native read settles', async () => {
  const before = save(day, 0);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release: () => void = () => {};
  let blocked = false;
  vi.mocked(stat).mockImplementation((path, ...options) => {
    if (String(path) !== output) return actual.stat(path, ...options);
    blocked = true;
    return new Promise((resolve, reject) => {
      release = () => {
        actual.stat(path, ...options).then(resolve, reject);
      };
    });
  });
  const stop = new AbortController();
  const work = refresh(stop.signal).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(blocked).toBe(true));
    stop.abort(new Error('higher pressure'));
    expect(await work).toMatchObject({ message: 'higher pressure' });
    expect(hungRead()).toBe(output);
    expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
  } finally {
    release();
    await pendingRead();
  }
  expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
});

test('a dirty event during the root reading survives the complete replacement generation', async () => {
  save(day, 0);
  let release = () => {};
  let started = false;
  vi.mocked(stages.readCheckout).mockImplementationOnce((path) => {
    const at = Date.now();
    started = true;
    return new Promise((resolve) => {
      release = () => resolve({ path, at, lastActivityAt: at, kept: null });
    });
  });
  const work = refresh();
  await vi.waitFor(() => expect(started).toBe(true));
  await vi.advanceTimersByTimeAsync(1);
  const dirtyAt = new Date().toISOString();
  writeFileSync(gcMarkFile(root), JSON.stringify({ ...readGcMark(root), dirtyAt }));
  release();
  await work;
  expect(readGcMark(root)).toMatchObject({ dirtyAt, candidates: [expect.objectContaining({ path: output })] });
  expect(readFileSync(join(output, 'artifact'), 'utf8')).toBe('keep');
});
