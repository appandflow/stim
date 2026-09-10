import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWarmLock, warmLockAcquiredLine, warmLockPath, warmLocksDir } from '../engine/warm-lock.ts';
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
  expect(copy.wait.holder).toEqual({
    pid: process.pid,
    installerPid: null,
    mode: 'refresh',
    startedAt: expect.any(String),
  });
  copy.release();
});

test('two refreshes never hold the lock at once', async () => {
  const first = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh' });
  let polls = 0;
  const second = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'refresh',
    sleep: async () => {
      if (++polls === 3) first.release();
    },
  });
  expect(polls).toBe(3);
  expect(second.wait.holder?.mode).toBe('refresh');
  second.release();
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
  expect(
    warmLockAcquiredLine({
      waitedMs: 12_000,
      holder: { pid: 41233, installerPid: null, mode: 'refresh', startedAt: null },
    }),
  ).toBe(`  ${'lock'.padEnd(11)} acquired (waited 12s for stim worktree warm --refresh pid 41233)`);
});

function writeWriterClaim(token: string, holder: Record<string, unknown>): void {
  const writer = join(warmLockPath(REPO), 'refresh');
  mkdirSync(writer, { recursive: true });
  writeFileSync(join(writer, `${token}.json`), JSON.stringify({ ...holder, mode: 'refresh', token }));
}

function writerClaimTokens(): string[] {
  return readdirSync(join(warmLockPath(REPO), 'refresh')).filter((name) => name.endsWith('.json'));
}

test('a reaper removes only the dead claim it observed, never the live one that replaced it', async () => {
  writeWriterClaim('dead', { pid: IMPOSSIBLE_PID, installerPid: null, startedAt: null });
  let swapped = false;
  let polls = 0;
  const copy = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'copy',
    isAlive: (pid) => {
      if (pid === IMPOSSIBLE_PID && !swapped) {
        swapped = true;
        rmSync(join(warmLockPath(REPO), 'refresh', 'dead.json'));
        writeWriterClaim('live', { pid: process.pid, installerPid: null, startedAt: null });
      }
      return pid === process.pid;
    },
    sleep: async () => {
      if (++polls === 2) rmSync(join(warmLockPath(REPO), 'refresh'), { recursive: true, force: true });
    },
  });
  expect(swapped).toBe(true);
  expect(polls).toBe(2);
  expect(copy.wait.holder).toMatchObject({ pid: process.pid, mode: 'refresh' });
  copy.release();
});

test('a writer directory with no owner record is free, not an abandoned claim to wait out', async () => {
  mkdirSync(join(warmLockPath(REPO), 'refresh'), { recursive: true });
  const refresh = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'refresh',
    sleep: async () => {
      throw new Error('waited on a writer directory that holds no claim');
    },
  });
  expect(refresh.wait.holder).toBe(null);
  const tokens = writerClaimTokens();
  expect(tokens).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(warmLockPath(REPO), 'refresh', String(tokens[0])), 'utf-8'))).toMatchObject({
    pid: process.pid,
    mode: 'refresh',
  });
  refresh.release();
});

test('a refresh claim whose installer is still running is not reapable', async () => {
  writeWriterClaim('dead-stim', { pid: IMPOSSIBLE_PID, installerPid: process.pid, startedAt: null });
  let polls = 0;
  const copy = await acquireWarmLock({
    repositoryRoot: REPO,
    mode: 'copy',
    sleep: async () => {
      if (++polls === 2) rmSync(join(warmLockPath(REPO), 'refresh'), { recursive: true, force: true });
    },
  });
  expect(polls).toBe(2);
  expect(copy.wait.holder).toMatchObject({ mode: 'refresh', installerPid: process.pid });
  copy.release();
});

test('a refresh records the installer it spawns on its claim and clears it again', async () => {
  const refresh = await acquireWarmLock({ repositoryRoot: REPO, mode: 'refresh' });
  const claim = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(warmLockPath(REPO), 'refresh', String(writerClaimTokens()[0])), 'utf-8'));
  expect(claim().installerPid).toBe(null);
  refresh.trackInstaller(IMPOSSIBLE_PID);
  expect(claim().installerPid).toBe(IMPOSSIBLE_PID);
  refresh.trackInstaller(null);
  expect(claim().installerPid).toBe(null);
  refresh.release();
});

test('a reap the filesystem refuses is reported instead of leaving the lock unclaimable', async () => {
  writeWriterClaim('dead', { pid: IMPOSSIBLE_PID, installerPid: null, startedAt: null });
  const writer = join(warmLockPath(REPO), 'refresh');
  chmodSync(writer, 0o500);
  try {
    const error = await acquireWarmLock({
      repositoryRoot: REPO,
      mode: 'refresh',
      sleep: async () => {
        throw new Error('waited instead of reporting the reap it could not do');
      },
    }).catch((thrown: NodeJS.ErrnoException) => thrown);
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
  } finally {
    chmodSync(writer, 0o700);
  }
});
