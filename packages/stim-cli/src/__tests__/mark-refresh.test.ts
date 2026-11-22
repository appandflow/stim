import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gcMarkFile, readGcMark, GC_MARK_VERSION, type Config, type GcMark } from '@stim-cli/core/state';
import * as stages from '../daemon/stages.ts';
import * as activity from '../workspace/discovered-activity.ts';
import { acquireDisk, CRITICAL, requestMark } from '../daemon/disk-owner.ts';
import * as discovery from '../workspace/discovery.ts';
import { refreshKnownMarks, refreshKnownOutputMark } from '../daemon/mark-refresh.ts';
import { hungRead, pendingRead } from '../workspace/bounded-read.ts';
import { saveConfig } from '../workspace/config.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, lstat: vi.fn<typeof fs.lstat>(fs.lstat), stat: vi.fn<typeof fs.stat>(fs.stat) };
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
  vi.mocked(lstat).mockImplementation(actual.lstat);
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

test.each([false, true])(
  'an output refresh preserves independent dependency evidence and provenance: holder=%s',
  async (holder) => {
    save(day, 0);
    const dependencyAt = new Date(Date.now() - 2 * day).toISOString();
    const dirtyAt = new Date(Date.now() - minute).toISOString();
    const dependencies = { markedAt: dependencyAt, role: 'source' as const, keys: [root], candidates: [] };
    const cargoVia = [join(root, 'apps', 'mobile')];
    const previous = { ...readGcMark(root), device: statSync(root).dev, dependencies, dirtyAt, cargoVia };
    writeFileSync(gcMarkFile(root), JSON.stringify(previous));
    await refreshKnownOutputMark(
      config,
      root,
      {},
      { devices: [], simsFailed: false, operation: testContext() },
      holder
        ? {
            holder: {
              root,
              device: statSync(root).dev,
              markedAt: readGcMark(root)?.markedAt ?? '',
              roots: [root],
              via: cargoVia,
            },
          }
        : {},
    );
    expect(readGcMark(root)).toMatchObject({ dependencies, dirtyAt, cargoVia, markedAt: new Date().toISOString() });
    expect(readGcMark(root)?.candidates).toContainEqual(expect.objectContaining({ path: output }));
  },
);

test.each(['generation', 'device'] as const)('changed holder %s keeps its previous generation', async (change) => {
  const before = save(day, 0);
  await refreshKnownOutputMark(
    config,
    root,
    {},
    { devices: [], simsFailed: false, operation: testContext() },
    {
      holder: {
        root,
        markedAt: change === 'generation' ? new Date().toISOString() : (readGcMark(root)?.markedAt ?? ''),
        device: statSync(root).dev + (change === 'device' ? 1 : 0),
        roots: [root],
        via: [],
      },
    },
  );
  expect(stages.readCheckout).not.toHaveBeenCalled();
  expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
});

test('later due roots refresh across successive batches when the first root repeatedly exhausts its budget', async () => {
  save(day, 0);
  const later = join(base, 'later');
  mkdirSync(later);
  config.projects[later] = {};
  saveConfig(config);
  let attempts = 0;
  let completed = 0;
  vi.mocked(stages.readCheckout).mockImplementation((path, _project, reading) => {
    if (path === root) {
      attempts++;
      return new Promise((_resolve, reject) =>
        reading.operation?.signal.addEventListener('abort', () => reject(reading.operation?.signal.reason), {
          once: true,
        }),
      );
    }
    completed++;
    return Promise.resolve({ path, at: Date.now(), lastActivityAt: Date.now(), kept: null });
  });
  const batch = () =>
    refreshKnownMarks(
      { config, known: [], holders: [], at: Date.now(), intervalMs: minute, devices: [], simsFailed: false },
      testContext(),
    );
  const first = batch();
  await vi.waitFor(() => expect(attempts).toBe(1));
  await vi.advanceTimersByTimeAsync(3_000);
  await first;
  expect(completed).toBe(0);
  for (const attempt of [2, 3]) {
    await vi.advanceTimersByTimeAsync(10 * minute);
    const next = batch();
    try {
      await vi.waitFor(() => expect(attempts).toBe(attempt));
      expect(completed).toBe(attempt - 1);
      expect(readGcMark(later)?.markedAt).toBeDefined();
    } finally {
      await vi.advanceTimersByTimeAsync(3_000);
      await next;
    }
  }
  expect(hungRead()).toBeNull();
});

test('a pending discovered .git probe releases the mark turn to critical pressure without publishing', async () => {
  const before = save(day, 0);
  vi.mocked(stages.readCheckout).mockImplementation(async (path, _project, reading) => {
    await activity.discoveredEvidence(path, {
      now: Date.now(),
      idleMs: 2 * minute,
      operation: reading.operation,
      reads: { processes: async () => null, sessions: async () => [] },
    });
    return { path, at: Date.now(), lastActivityAt: Date.now(), kept: null };
  });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let pending = false;
  let finish = () => {};
  const gitPath = join(root, '.git');
  vi.mocked(lstat).mockImplementation((...args) => {
    if (String(args[0]) !== gitPath) return actual.lstat(...args);
    pending = true;
    return new Promise((_resolve, reject) => {
      finish = () => reject(new Error('released pending metadata'));
    });
  });
  const asked = requestMark((signal) =>
    refreshKnownOutputMark(
      config,
      root,
      {},
      {
        devices: [],
        simsFailed: false,
        operation: testContext(),
      },
      { signal },
    ),
  );
  const result = asked.result.catch((error: unknown) => error);
  let pressure: ReturnType<typeof acquireDisk> | undefined;
  try {
    await vi.waitFor(() => expect(pending).toBe(true));
    let granted = false;
    pressure = acquireDisk(CRITICAL).then((turn) => {
      granted = true;
      return turn;
    });
    await vi.waitFor(() => expect(granted).toBe(true));
    expect(await result).toMatchObject({ message: 'mark refresh interrupted by pressure' });
    expect(hungRead()).toBe(gitPath);
    expect(readFileSync(gcMarkFile(root), 'utf8')).toBe(before);
  } finally {
    asked.leave();
    finish();
    await pendingRead();
    await result;
    (await pressure)?.release();
  }
});
