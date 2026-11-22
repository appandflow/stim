import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trashRoot } from '@stim-cli/core/state';
import { trashHealthFindings } from '../diagnostics/doctor-trash.ts';
import { itemTrashInventory, pendingItemTrash } from '../workspace/item-trash.ts';
import { TRASH_MANIFEST } from '../workspace/worktree-trash.ts';
import { hungRead, pendingRead } from '../workspace/bounded-read.ts';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: vi.fn<typeof fs.lstat>(fs.lstat),
    readFile: vi.fn<typeof fs.readFile>(fs.readFile),
    readdir: vi.fn<typeof fs.readdir>(fs.readdir),
  };
});

const day = 24 * 60 * 60_000;
let home: string;
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(fs.lstat);
  vi.mocked(readFile).mockImplementation(fs.readFile);
  vi.mocked(readdir).mockImplementation(fs.readdir);
  vi.clearAllMocks();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-trash-health-')));
  vi.stubEnv('STIM_HOME', home);
});
afterEach(async () => {
  await pendingRead();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function entry(name: string, age: number, extra = {}) {
  const path = join(trashRoot(), `item-${name}`);
  mkdirSync(join(path, 'entries', 'payload'), { recursive: true });
  writeFileSync(join(path, 'entries', 'payload', 'keep'), 'payload');
  writeFileSync(
    join(path, TRASH_MANIFEST),
    JSON.stringify({
      kind: 'gc-item',
      createdAt: new Date(Date.now() - age).toISOString(),
      source: { kind: 'cache', id: '/selected/cache' },
      bytes: 123,
      ...extra,
    }),
  );
  return path;
}

test.each([0, day, day + 1])('reports only a verified entry strictly over 24 hours old: %i', async (age) => {
  const path = entry('cache', age);
  const findings = await trashHealthFindings(Date.now());
  expect(findings).toHaveLength(age > day ? 1 : 0);
  const stale = expect.objectContaining({ code: 'gc-trash-stale', detail: expect.stringContaining(path) });
  expect(findings).toEqual(age > day ? [stale] : []);
  expect(readFileSync(join(path, 'entries', 'payload', 'keep'), 'utf8')).toBe('payload');
  expect(vi.mocked(readdir).mock.calls.map(([file]) => String(file))).toEqual([trashRoot()]);
  expect(vi.mocked(readFile).mock.calls.map(([file]) => String(file))).toEqual([join(path, TRASH_MANIFEST)]);
});

test('the shared inventory keeps pending estimates and selects only the oldest valid typed entry', async () => {
  entry('new', 1);
  const oldest = entry('old', 2 * day);
  entry('invalid-date', 0, { createdAt: 'invalid' });
  entry('foreign', 4 * day, { kind: 'worktree' });
  const broken = entry('broken', 4 * day);
  writeFileSync(join(broken, TRASH_MANIFEST), '{');
  const missing = entry('missing', 3 * day);
  rmSync(join(missing, 'entries', 'payload'), { recursive: true });
  expect(await itemTrashInventory()).toEqual({
    count: 4,
    complete: true,
    bytes: 3 * 123,
    oldest: { path: oldest, createdAt: new Date(Date.now() - 2 * day).toISOString() },
  });
  expect(await pendingItemTrash()).toEqual({ count: 4, bytes: 3 * 123 });
  expect(await trashHealthFindings(Date.now())).toMatchObject([{ detail: expect.stringContaining(oldest) }]);
});

test('entry, payload and manifest links cannot invent stale evidence', async () => {
  const target = entry('target', 2 * day, { kind: 'worktree' });
  const linked = join(trashRoot(), 'item-linked');
  symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const payload = entry('payload', 2 * day);
  rmSync(join(payload, 'entries', 'payload'), { recursive: true });
  symlinkSync(
    join(target, 'entries', 'payload'),
    join(payload, 'entries', 'payload'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const entries = entry('entries', 2 * day);
  rmSync(join(entries, 'entries'), { recursive: true });
  symlinkSync(join(target, 'entries'), join(entries, 'entries'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifestTarget = entry('manifest-target', 2 * day);
  rmSync(join(manifestTarget, 'entries', 'payload'), { recursive: true });
  const manifest = entry('manifest', 2 * day);
  rmSync(join(manifest, TRASH_MANIFEST));
  symlinkSync(join(manifestTarget, TRASH_MANIFEST), join(manifest, TRASH_MANIFEST), 'file');
  expect(await trashHealthFindings(Date.now())).toEqual([]);
  expect(vi.mocked(readFile).mock.calls.map(([file]) => String(file))).not.toContain(join(manifest, TRASH_MANIFEST));
});

test('a missing trash root supplies no stale finding', async () => {
  expect(await trashHealthFindings(Date.now())).toEqual([]);
  expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
});

test.each([false, true])('a blocked manifest is bounded and caller cancellation propagates: %s', async (cancel) => {
  const path = entry('blocked', 2 * day);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let finish = () => {};
  let reading = false;
  vi.mocked(readFile).mockImplementation((...args) => {
    if (String(args[0]) !== join(path, TRASH_MANIFEST)) return actual.readFile(...args);
    reading = true;
    return new Promise((resolve) => {
      finish = () => resolve('{}');
    });
  });
  const stop = new AbortController();
  const work = trashHealthFindings(Date.now(), stop.signal).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    if (cancel) stop.abort(new Error('caller stopped'));
    else await vi.advanceTimersByTimeAsync(3_000);
    const stopped = expect.objectContaining({ message: 'caller stopped' });
    expect(await work).toEqual(cancel ? stopped : []);
    expect(hungRead()).toBe(path);
  } finally {
    finish();
    await pendingRead();
  }
});

test('an oversized manifest is skipped before opening without changing the legacy pending estimate', async () => {
  const path = entry('large', 2 * day, { padding: 'x'.repeat(70_000) });
  expect(await trashHealthFindings(Date.now())).toEqual([]);
  expect(vi.mocked(readFile).mock.calls.map(([file]) => String(file))).not.toContain(join(path, TRASH_MANIFEST));
  expect(await pendingItemTrash()).toEqual({ count: 1, bytes: 123 });
});

test('a later read deadline retains already verified stale evidence and marks the scan partial', async () => {
  const stale = entry('a-stale', 2 * day);
  const blocked = entry('z-blocked', 2 * day);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readdir).mockImplementationOnce(async (...args) =>
    (await actual.readdir(...args)).toSorted((first, second) => String(first).localeCompare(String(second))),
  );
  let finish = () => {};
  let reading = false;
  vi.mocked(readFile).mockImplementation((...args) => {
    if (String(args[0]) !== join(blocked, TRASH_MANIFEST)) return actual.readFile(...args);
    reading = true;
    return new Promise((resolve) => {
      finish = () => resolve('{}');
    });
  });
  const work = trashHealthFindings(Date.now());
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await work).toMatchObject([{ detail: expect.stringContaining(stale) }]);
    expect((await work)[0]?.detail).toContain('Other entries could not all be checked.');
  } finally {
    finish();
    await pendingRead();
  }
});
