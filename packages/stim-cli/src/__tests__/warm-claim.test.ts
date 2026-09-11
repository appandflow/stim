import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWarmClaim,
  warmClaimAcquiredLine,
  warmClaimBlockedLine,
  warmClaimBlockedRefusal,
  warmClaimBlocker,
  warmClaimDegradation,
  warmClaimPath,
  warmClaimsDir,
} from '../engine/warm-claim.ts';
import { getExecutor } from '../exec.ts';
import {
  CLAIM_PATH_NOT_A_DIRECTORY,
  ClaimRefusedError,
  ClaimUnavailableError,
  exclusiveClaimDir,
  readClaimSet,
  sharedClaimDir,
} from '../ownership-claim.ts';
import { IMPOSSIBLE_PID, goneClaimOwner, plantClaim, recycledClaimOwner } from './_factories.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-warm-claim-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const REPO = '/w/monorepo';

const never = async (): Promise<void> => {
  throw new Error('waited instead of taking a claim nothing holds');
};

function exclusiveClaimFile(): string {
  const dir = exclusiveClaimDir(warmClaimPath(REPO));
  const name = readdirSync(dir).find((entry) => entry.endsWith('.claim'));
  if (!name) throw new Error('no exclusive claim in the warm claim set');
  return join(dir, name);
}

test('every app in one repository resolves the same claim, keyed on the repository root', () => {
  expect(warmClaimPath(REPO)).toBe(warmClaimPath(REPO));
  expect(warmClaimPath(`${REPO}/apps/a`)).not.toBe(warmClaimPath(REPO));
  expect(warmClaimPath(REPO).startsWith(join(warmClaimsDir(), 'monorepo--'))).toBe(true);
});

test('two copies hold the claim at the same time', async () => {
  const first = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  const second = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  expect(first.wait.holder).toBe(null);
  expect(second.wait.holder).toBe(null);
  expect(readClaimSet(warmClaimPath(REPO)).live).toHaveLength(2);
  first.release();
  second.release();
});

test('a copy waits for a refresh in flight and names it', async () => {
  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  let polls = 0;
  const copy = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'copy',
    sleep: async () => {
      if (++polls === 3) refresh.release();
    },
  });
  expect(polls).toBe(3);
  expect(copy.wait.holder).toEqual({ pid: process.pid, phase: 'refresh' });
  expect(existsSync(sharedClaimDir(warmClaimPath(REPO)))).toBe(true);
  copy.release();
});

test('two refreshes never hold the claim at once', async () => {
  const first = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  let polls = 0;
  const second = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'refresh',
    sleep: async () => {
      if (++polls === 3) first.release();
    },
  });
  expect(polls).toBe(3);
  expect(second.wait.holder).toEqual({ pid: process.pid, phase: 'refresh' });
  second.release();
});

test('a refresh drains the copies in flight before it starts, and blocks new ones while it waits', async () => {
  const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  let polls = 0;
  let blocked = 0;
  const refresh = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'refresh',
    sleep: async () => {
      if (++polls === 1) {
        await acquireWarmClaim({
          repositoryRoot: REPO,
          phase: 'copy',
          sleep: async () => {
            blocked++;
            throw new Error('stop');
          },
        }).catch(() => {});
      }
      if (polls === 2) copy.release();
    },
  });
  expect(blocked).toBe(1);
  expect(refresh.wait.holder).toEqual({ pid: process.pid, phase: 'copy' });
  refresh.release();
});

test('a dead refresh holder and a dead copy holder are both reclaimed without waiting', async () => {
  const root = warmClaimPath(REPO);
  plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'dead-refresh' });
  plantClaim(root, 'shared', goneClaimOwner(), { claimId: 'dead-copy' });
  const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  expect(copy.wait.holder).toBe(null);
  copy.release();
  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  expect(refresh.wait.holder).toBe(null);
  refresh.release();
});

test('a refresh claim whose pid was recycled is reclaimed, not waited out', async () => {
  plantClaim(warmClaimPath(REPO), 'exclusive', recycledClaimOwner(), { claimId: 'recycled' });
  const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  expect(copy.wait.holder).toBe(null);
  copy.release();
});

test('a claim Stim cannot resolve refuses both phases and names the removal of that claim', async () => {
  const root = warmClaimPath(REPO);
  const path = plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'half-spawned', child: { record: null } });
  for (const phase of ['copy', 'refresh'] as const) {
    const error = await acquireWarmClaim({ repositoryRoot: REPO, phase, sleep: never }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ClaimRefusedError);
    expect((error as ClaimRefusedError).message).toContain('worktree warm claim');
    expect((error as ClaimRefusedError).removeCommand).toContain(path);
  }
  expect(existsSync(path)).toBe(true);
});

test('a wait that outlives the ceiling refuses with STIM_LOCK_TIMEOUT and names the holder', async () => {
  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  let clock = 0;
  const error = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'copy',
    now: () => (clock += 1000),
    ceilingMs: 5000,
    sleep: async () => {},
  }).catch((thrown: unknown) => thrown);
  refresh.release();
  expect((error as Error & { code?: string }).code).toBe('STIM_LOCK_TIMEOUT');
  expect((error as Error).message).toMatch(/stim worktree warm --refresh \(pid \d+\)/);
  expect((error as Error).message).toContain(warmClaimPath(REPO));
});

test('a refresh that gives up while copies drain leaves no claim of its own behind', async () => {
  const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  let clock = 0;
  const error = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'refresh',
    now: () => (clock += 1000),
    ceilingMs: 3000,
    sleep: async () => {},
  }).catch((thrown: unknown) => thrown);
  expect((error as Error & { code?: string }).code).toBe('STIM_LOCK_TIMEOUT');
  expect(existsSync(exclusiveClaimDir(warmClaimPath(REPO)))).toBe(false);
  copy.release();
  const after = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  expect(after.wait.holder).toBe(null);
  after.release();
});

test('a wait attributes elapsed time to the waiter and names its holder every progress interval', async () => {
  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  const lines: string[] = [];
  let clock = 120_000;
  let polls = 0;
  const copy = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'copy',
    now: () => clock,
    progressMs: 30_000,
    out: (line) => lines.push(line),
    sleep: async () => {
      clock += 10_000;
      if (++polls === 8) refresh.release();
    },
  });
  expect(lines).toEqual([
    `  lock        waiting 30s for stim worktree warm --refresh (pid ${process.pid}) -- stim guide lifecycle options`,
    `  lock        waiting 1m00s for stim worktree warm --refresh (pid ${process.pid}) -- stim guide lifecycle options`,
  ]);
  expect(copy.wait.waitedMs).toBe(80_000);
  copy.release();
});

test('the acquired line reports a wait only when there was one', () => {
  expect(warmClaimAcquiredLine({ waitedMs: 0, holder: null })).toBe(`  ${'lock'.padEnd(11)} acquired`);
  expect(warmClaimAcquiredLine({ waitedMs: 12_000, holder: { pid: 41233, phase: 'refresh' } })).toBe(
    `  ${'lock'.padEnd(11)} acquired (waited 12s for stim worktree warm --refresh pid 41233) -- stim guide lifecycle options`,
  );
});

test('a copy proceeds without a claim only when no claim could be recorded at all', () => {
  expect(warmClaimDegradation(new ClaimUnavailableError('ENOSYS (no prebuild for this platform)'))).toContain(
    'ENOSYS (no prebuild for this platform)',
  );
  expect(warmClaimDegradation(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))).toBe(
    'EACCES: permission denied',
  );
  expect(
    warmClaimDegradation(
      new ClaimRefusedError({ claimPath: '/h/a.claim', root: '/h', reason: 'truncated', label: 'worktree warm' }),
    ),
  ).toBe(null);
  expect(warmClaimDegradation(Object.assign(new Error('waited'), { code: 'STIM_LOCK_TIMEOUT' }))).toBe(null);
});

test('the installer process group keeps the claim after the refresh that spawned it is gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-test-warm-installer-'));
  const leader = join(dir, 'leader.mjs');
  const pidFile = join(dir, 'grandchild.pid');
  writeFileSync(
    leader,
    [
      'const { spawn } = await import("node:child_process");',
      'const { writeFileSync } = await import("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'child.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ].join('\n'),
  );

  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  const installer = getExecutor().spawn(process.execPath, [leader], { detached: true, stdio: 'ignore' });
  if (!installer.pid) throw new Error('the installer did not start');
  refresh.installer.declare();
  refresh.installer.record(installer.pid);
  await once(installer, 'exit');

  let grandchild = 0;
  for (let attempt = 0; attempt < 200 && !grandchild; attempt++) {
    try {
      grandchild = Number(readFileSync(pidFile, 'utf-8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!grandchild) throw new Error('the installer never spawned its own child');

  try {
    const claim = exclusiveClaimFile();
    const record = JSON.parse(readFileSync(claim, 'utf-8'));
    writeFileSync(claim, JSON.stringify({ ...record, owner: goneClaimOwner() }));

    let polls = 0;
    await acquireWarmClaim({
      repositoryRoot: REPO,
      phase: 'copy',
      sleep: async () => {
        polls++;
        throw new Error('stop');
      },
    }).catch(() => {});
    expect(polls).toBe(1);

    process.kill(grandchild, 'SIGKILL');
    for (let attempt = 0; attempt < 200 && readClaimSet(warmClaimPath(REPO)).live.length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
    expect(copy.wait.holder).toBe(null);
    copy.release();
  } finally {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an installer whose identity cannot be captured leaves the claim unresolvable rather than free', async () => {
  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  refresh.installer.declare();
  const claim = exclusiveClaimFile();
  const record = JSON.parse(readFileSync(claim, 'utf-8'));
  writeFileSync(claim, JSON.stringify({ ...record, owner: goneClaimOwner() }));
  const error = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never }).catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ClaimRefusedError);
  expect(await refresh.installer.settle()).toEqual({ settled: true, pid: null, waitedMs: expect.any(Number) });
  refresh.release();
});

test('a pid that no longer exists is not a writer to hold the claim for', async () => {
  const lines: string[] = [];
  const refresh = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'refresh',
    sleep: never,
    out: (line) => lines.push(line),
  });
  refresh.installer.declare();
  refresh.installer.record(IMPOSSIBLE_PID);
  expect((await refresh.installer.settle()).settled).toBe(true);
  expect(lines).toEqual([]);
  refresh.release();
  expect(existsSync(warmClaimPath(REPO))).toBe(false);
});

test('a claim store whose own path is a file degrades a copy; an unresolvable claim in it does not', () => {
  const notADirectory = new ClaimRefusedError({
    claimPath: '/h/warm-locks/main--a.lock',
    root: '/h/warm-locks/main--a.lock',
    reason: CLAIM_PATH_NOT_A_DIRECTORY,
    label: 'worktree warm',
  });
  expect(warmClaimDegradation(notADirectory)).toBe(`/h/warm-locks/main--a.lock: ${CLAIM_PATH_NOT_A_DIRECTORY}`);
  expect(
    warmClaimDegradation(
      new ClaimRefusedError({
        claimPath: '/h/warm-locks/main--a.lock/exclusive/x.claim',
        root: '/h/warm-locks/main--a.lock',
        reason: 'its record is missing, truncated or not valid JSON',
        label: 'worktree warm',
      }),
    ),
  ).toBe(null);
});

test('a copy with no claim of its own reads what it would overlap before it copies', async () => {
  expect(warmClaimBlocker(REPO)).toBe(null);

  const copy = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'copy', sleep: never });
  expect(warmClaimBlocker(REPO)).toBe(null);
  copy.release();

  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  const blocker = warmClaimBlocker(REPO);
  expect(blocker).toEqual({ kind: 'refresh', holder: { pid: process.pid, phase: 'refresh' } });
  expect(warmClaimBlockedLine('EACCES: permission denied', blocker!)).toMatch(
    /^ {2}lock {8}unavailable \(EACCES: permission denied\); stim worktree warm --refresh \(pid \d+\) holds this repository$/,
  );
  expect(warmClaimBlockedRefusal(blocker!)).toContain('Refusing to copy from a source checkout a refresh is rewriting');
  refresh.release();

  plantClaim(warmClaimPath(REPO), 'exclusive', goneClaimOwner(), { claimId: 'dead-refresh' });
  expect(warmClaimBlocker(REPO)).toBe(null);

  const path = plantClaim(warmClaimPath(REPO), 'exclusive', goneClaimOwner(), {
    claimId: 'half-spawned',
    child: { record: null },
  });
  expect(warmClaimBlocker(REPO)).toEqual({ kind: 'unresolved', path, reason: expect.any(String) });
  expect(warmClaimBlockedRefusal(warmClaimBlocker(REPO)!)).toContain(path);
});

test('settling the installer waits for its process group, not for the process that led it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-test-warm-settle-'));
  const pidFile = join(dir, 'grandchild.pid');
  const leader = join(dir, 'leader.mjs');
  writeFileSync(
    leader,
    [
      'const { spawn } = await import("node:child_process");',
      'const { writeFileSync } = await import("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'child.unref();',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ].join('\n'),
  );

  const refresh = await acquireWarmClaim({ repositoryRoot: REPO, phase: 'refresh', sleep: never });
  const installer = getExecutor().spawn(process.execPath, [leader], { detached: true, stdio: 'ignore' });
  if (!installer.pid) throw new Error('the installer did not start');
  refresh.installer.declare();
  refresh.installer.record(installer.pid);
  await once(installer, 'exit');

  let grandchild = 0;
  for (let attempt = 0; attempt < 200 && !grandchild; attempt++) {
    try {
      grandchild = Number(readFileSync(pidFile, 'utf-8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!grandchild) throw new Error('the installer never spawned its own child');

  try {
    let settled = false;
    const settling = refresh.installer.settle().then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(readClaimSet(warmClaimPath(REPO)).live).toHaveLength(1);

    process.kill(grandchild, 'SIGKILL');
    expect(await settling).toMatchObject({ settled: true });
    refresh.release();
    expect(existsSync(warmClaimPath(REPO))).toBe(false);
  } finally {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a child record that cannot be written leaves the claim held while the writer it names runs', async () => {
  const lines: string[] = [];
  const refresh = await acquireWarmClaim({
    repositoryRoot: REPO,
    phase: 'refresh',
    sleep: never,
    out: (line) => lines.push(line),
  });
  const writer = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  if (!writer.pid) throw new Error('the writer did not start');
  const group = writer.pid;
  try {
    refresh.installer.declare();
    chmodSync(exclusiveClaimDir(warmClaimPath(REPO)), 0o500);
    refresh.installer.record(group);
    expect(lines.join('\n')).toMatch(/lock {8}could not record the install this refresh spawned \(.*EACCES/);

    refresh.release();
    expect(readClaimSet(warmClaimPath(REPO)).live.some((holder) => holder.mode === 'exclusive')).toBe(true);
    let polls = 0;
    await acquireWarmClaim({
      repositoryRoot: REPO,
      phase: 'copy',
      sleep: async () => {
        polls++;
        throw new Error('stop');
      },
    }).catch(() => {});
    expect(polls).toBe(1);
  } finally {
    chmodSync(exclusiveClaimDir(warmClaimPath(REPO)), 0o700);
    try {
      process.kill(-group, 'SIGKILL');
    } catch {}
  }
  expect(await refresh.installer.settle()).toMatchObject({ settled: true });
  refresh.release();
  expect(existsSync(warmClaimPath(REPO))).toBe(false);
});
