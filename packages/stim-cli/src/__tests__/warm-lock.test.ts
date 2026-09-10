import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWarmLock,
  warmLockAcquiredLine,
  warmLockPath,
  warmLockWaitingLine,
  warmLocksDir,
} from '../engine/warm-lock.ts';
import { IMPOSSIBLE_PID } from './_factories.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-warm-lock-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const REPO = '/w/monorepo';

test('every app in one repository resolves the same lock, keyed on the repository root', () => {
  expect(warmLockPath(REPO)).toBe(warmLockPath(REPO));
  expect(warmLockPath(`${REPO}/apps/a`)).not.toBe(warmLockPath(REPO));
  expect(warmLockPath(REPO).startsWith(join(warmLocksDir(), 'monorepo--'))).toBe(true);
});

test('two copies hold the lock at the same time', async () => {
  const first = await acquireWarmLock({ repositoryRoot: REPO, mode: 'copy' });
  const second = await acquireWarmLock({ repositoryRoot: REPO, mode: 'copy' });
  expect(first.wait.holder).toBe(null);
  expect(second.wait.holder).toBe(null);
  first.release();
  second.release();
});

test('a copy waits for a refresh in flight and names it', async () => {
  const refresh = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh' });
  let polls = 0;
  const copy = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'copy',
    sleep: async () => {
      if (++polls === 3) refresh.release();
    },
  });
  expect(polls).toBe(3);
  expect(copy.wait.holder).toEqual({ pid: process.pid, mode: 'refresh', startedAt: expect.any(String) });
  copy.release();
});

test('a refresh waits for a copy in flight to finish before it starts', async () => {
  const copy = await acquireWarmLock({ repositoryRoot: REPO, mode: 'copy' });
  let polls = 0;
  const refresh = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'refresh',
    sleep: async () => {
      if (++polls === 2) copy.release();
    },
  });
  expect(polls).toBe(2);
  expect(refresh.wait.holder?.mode).toBe('copy');
  refresh.release();
});

test('a dead refresh holder and a dead copy holder are both reclaimed without waiting', async () => {
  const paths = warmLockPath(REPO);
  mkdirSync(join(paths, 'refresh'), { recursive: true });
  writeFileSync(
    join(paths, 'refresh', 'owner.json'),
    JSON.stringify({ pid: IMPOSSIBLE_PID, mode: 'refresh', startedAt: null, token: 'dead' }),
  );
  mkdirSync(join(paths, 'copies'), { recursive: true });
  writeFileSync(
    join(paths, 'copies', `${IMPOSSIBLE_PID}-dead.json`),
    JSON.stringify({ pid: IMPOSSIBLE_PID, mode: 'copy', startedAt: null, token: 'dead' }),
  );
  const sleep = async (): Promise<void> => {
    throw new Error('waited on a dead holder');
  };
  const copy = await acquireWarmLock({ repositoryRoot: REPO, mode: 'copy', sleep });
  expect(copy.wait.holder).toBe(null);
  copy.release();
  const refresh = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh', sleep });
  expect(refresh.wait.holder).toBe(null);
  expect(readdirSync(join(paths, 'copies'))).toEqual([]);
  refresh.release();
});

test('a wait that outlives the ceiling refuses with STIM_LOCK_TIMEOUT and names the holder', async () => {
  const refresh = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh' });
  let clock = 0;
  const error = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'copy',
    now: () => (clock += 1000),
    ceilingMs: 5000,
    sleep: async () => {},
  }).catch((thrown: Error & { code?: string }) => thrown);
  refresh.release();
  expect((error as Error & { code?: string }).code).toBe('STIM_LOCK_TIMEOUT');
  expect((error as Error).message).toMatch(/stim worktree warm --refresh \(pid \d+\)/);
  expect((error as Error).message).toContain(warmLockPath(REPO));
});

test('a wait prints its holder every progress interval, in the shape build waits use', async () => {
  const refresh = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh' });
  const lines: string[] = [];
  let clock = 0;
  let polls = 0;
  const copy = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'copy',
    now: () => (clock += 10_000),
    progressMs: 30_000,
    out: (line) => lines.push(line),
    sleep: async () => {
      if (++polls === 8) refresh.release();
    },
  });
  expect(lines[0]).toMatch(/^ {2}lock {8}waiting on stim worktree warm --refresh \(pid \d+, \d+m?\d*s elapsed\)$/);
  expect(lines.length).toBeGreaterThan(1);
  copy.release();
});

test('the acquired line reports a wait only when there was one', () => {
  expect(warmLockAcquiredLine({ waitedMs: 0, holder: null })).toBe(`  ${'lock'.padEnd(11)} acquired`);
  expect(warmLockAcquiredLine({ waitedMs: 12_000, holder: { pid: 41233, mode: 'refresh', startedAt: null } })).toBe(
    `  ${'lock'.padEnd(11)} acquired (waited 12s for stim worktree warm --refresh pid 41233)`,
  );
  expect(warmLockWaitingLine({ pid: 41233, mode: 'refresh', startedAt: null }, 40_000)).toBe(
    `  ${'lock'.padEnd(11)} waiting on stim worktree warm --refresh (pid 41233, 40s elapsed)`,
  );
});
