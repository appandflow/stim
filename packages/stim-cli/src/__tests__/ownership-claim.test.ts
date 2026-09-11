import assert from 'node:assert';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { captureProcessToken } from '../process-identity.ts';
import {
  claimLiveness,
  claimRemoveCommand,
  clearClaimChild,
  exclusiveClaimDir,
  inspectClaimSet,
  isClaimRefusal,
  markClaimChildPending,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  settleClaim,
  sharedClaimDir,
  tryAcquireClaim,
} from '../ownership-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim, recycledClaimOwner } from './_factories.ts';

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'stim-claim-')), 'build.lock');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('exclusive claims', () => {
  test('one process holds it and the next reads who holds it', () => {
    const first = tryAcquireClaim({ root, mode: 'exclusive', details: { projectRoot: '/w/a' } });
    assert(first.acquired);
    expect(first.acquired.owner.pid).toBe(process.pid);

    const second = tryAcquireClaim({ root, mode: 'exclusive' });
    expect(second.acquired).toBe(undefined);
    assert(second.held);
    expect(second.held.claimId).toBe(first.acquired.claimId);
    expect(second.held.details).toEqual({ projectRoot: '/w/a' });
  });

  test('a released claim leaves nothing behind and can be taken again', () => {
    const first = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(first.acquired);
    expect(releaseClaim(first.acquired)).toBe(true);
    expect(existsSync(exclusiveClaimDir(root))).toBe(false);
    expect(releaseClaim(first.acquired)).toBe(true);
    expect(tryAcquireClaim({ root, mode: 'exclusive' }).acquired).toBeTruthy();
  });

  test('release refuses when another process replaced the claim', () => {
    const first = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(first.acquired);
    writeFileSync(
      first.acquired.path,
      JSON.stringify({ claimId: 'someone-else', mode: 'exclusive', owner: liveClaimOwner() }),
    );
    expect(releaseClaim(first.acquired)).toBe(false);
    expect(existsSync(first.acquired.path)).toBe(true);
  });

  test('age is never a reason: an ancient claim whose holder runs is still held', () => {
    const first = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(first.acquired);
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    utimesSync(first.acquired.path, longAgo, longAgo);
    utimesSync(exclusiveClaimDir(root), longAgo, longAgo);
    expect(tryAcquireClaim({ root, mode: 'exclusive' }).held?.claimId).toBe(first.acquired.claimId);
  });

  test('a claim whose holder is gone is reaped and reported', () => {
    plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'dead-one', details: { projectRoot: '/gone' } });
    const got = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(got.acquired);
    expect(got.reaped.map((h) => h.claimId)).toEqual(['dead-one']);
    expect(got.reaped[0]!.details).toEqual({ projectRoot: '/gone' });
    expect(readdirSync(exclusiveClaimDir(root))).toEqual([`${got.acquired.claimId}.claim`]);
  });

  test('a recycled pid is a gone holder, not a live one', () => {
    plantClaim(root, 'exclusive', recycledClaimOwner(), { claimId: 'recycled' });
    const got = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(got.acquired);
    expect(got.reaped.map((h) => h.claimId)).toEqual(['recycled']);
  });

  test('an empty claim directory left by a crash blocks nothing', () => {
    mkdirSync(exclusiveClaimDir(root), { recursive: true });
    expect(tryAcquireClaim({ root, mode: 'exclusive' }).acquired).toBeTruthy();
  });
});

describe('refusing instead of guessing', () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      if (!isClaimRefusal(err)) throw err;
      return err;
    }
    throw new Error('the claim was resolved when it could not be');
  };

  test('a record with no usable process token refuses, names the claim and the command, and removes nothing', () => {
    const path = plantClaim(root, 'exclusive', { pid: 4242, processToken: 'not-a-token' }, { claimId: 'mystery' });
    const err = refusal(() => tryAcquireClaim({ root, mode: 'exclusive', label: 'ios build' }));
    expect(err.claimPath).toBe(path);
    expect(err.removeCommand).toBe(claimRemoveCommand(root));
    expect(err.message).toContain(path);
    expect(err.message).toContain(`rm -rf ${root}`);
    expect(err.message).toContain('ios build');
    expect(existsSync(path)).toBe(true);
  });

  test('an unreadable record is not a dead holder', () => {
    const dir = exclusiveClaimDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'truncated.claim'), '{"claimId":"truncated","owner":{"pid"');
    refusal(() => tryAcquireClaim({ root, mode: 'exclusive' }));
    expect(existsSync(join(dir, 'truncated.claim'))).toBe(true);
  });

  test('a claim that declared a child and never recorded it refuses', () => {
    plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'spawning', child: { record: null } });
    const err = refusal(() => tryAcquireClaim({ root, mode: 'exclusive' }));
    expect(err.message).toMatch(/killed before recording which one/);
  });

  test('a child marker Stim cannot read is not a claim it may reap', () => {
    const path = plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'stuck' });
    mkdirSync(join(exclusiveClaimDir(root), 'stuck.child', 'not-empty'), { recursive: true });
    refusal(() => tryAcquireClaim({ root, mode: 'exclusive' }));
    expect(existsSync(path)).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)('a reap that fails for any reason but ENOENT refuses', () => {
    const path = plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'unremovable' });
    chmodSync(exclusiveClaimDir(root), 0o500);
    try {
      const err = refusal(() => tryAcquireClaim({ root, mode: 'exclusive' }));
      expect(err.message).toMatch(/could not be removed/);
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(exclusiveClaimDir(root), 0o700);
    }
  });

  test('a claim directory holding foreign files refuses rather than being overwritten', () => {
    const dir = exclusiveClaimDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const err = refusal(() => tryAcquireClaim({ root, mode: 'exclusive' }));
    expect(err.message).toMatch(/files Stim did not write/);
  });
});

describe('shared and exclusive', () => {
  test('shared claims coexist and hold an exclusive acquirer off until the last one goes', () => {
    const a = tryAcquireClaim({ root, mode: 'shared' });
    const b = tryAcquireClaim({ root, mode: 'shared' });
    assert(a.acquired && b.acquired);
    expect(readClaimSet(root).live.length).toBe(2);

    const writer = tryAcquireClaim({ root, mode: 'exclusive' });
    expect(writer.acquired).toBe(undefined);
    assert(writer.pending && writer.waitingFor);
    expect(writer.waitingFor.length).toBe(2);

    releaseClaim(a.acquired);
    expect(settleClaim(writer.pending).acquired).toBe(undefined);
    releaseClaim(b.acquired);
    expect(settleClaim(writer.pending).acquired?.claimId).toBe(writer.pending.claimId);
  });

  test('a reader yields to a live exclusive claim and leaves no claim of its own behind', () => {
    const writer = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(writer.acquired);
    const reader = tryAcquireClaim({ root, mode: 'shared' });
    expect(reader.acquired).toBe(undefined);
    expect(reader.held?.claimId).toBe(writer.acquired.claimId);
    expect(existsSync(sharedClaimDir(root))).toBe(false);
  });

  test('a waiting writer keeps its claim, so new readers wait rather than starving it', () => {
    const reader = tryAcquireClaim({ root, mode: 'shared' });
    assert(reader.acquired);
    const writer = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(writer.pending);
    expect(tryAcquireClaim({ root, mode: 'shared' }).acquired).toBe(undefined);
    releaseClaim(reader.acquired);
    expect(settleClaim(writer.pending).acquired).toBeTruthy();
  });

  test('a shared claim whose holder is gone is reaped', () => {
    plantClaim(root, 'shared', goneClaimOwner(), { claimId: 'dead-reader' });
    const got = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(got.acquired);
    expect(got.reaped.map((h) => h.claimId)).toEqual(['dead-reader']);
  });
});

describe('a claim whose work runs in a spawned process group', () => {
  test('the claim stays held while a descendant of the recorded child is alive, and is reaped once the group exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-claim-group-'));
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

    const held = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(held.acquired);
    const group = getExecutor().spawn(process.execPath, [leader], { detached: true, stdio: 'ignore' });
    assert(group.pid);
    const childRecord = { pid: group.pid, processToken: captureProcessToken(group.pid)! };
    expect(childRecord.processToken).toBeTruthy();
    markClaimChildPending(held.acquired);
    setClaimChild(held.acquired, childRecord);
    await once(group, 'exit');

    let grandchild = 0;
    for (let i = 0; i < 200 && !grandchild; i++) {
      try {
        grandchild = Number(readFileSync(pidFile, 'utf-8'));
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert(grandchild > 0);

    try {
      const dead = goneClaimOwner();
      writeFileSync(
        held.acquired.path,
        JSON.stringify({ claimId: held.acquired.claimId, mode: 'exclusive', owner: dead, startedAt: '', details: {} }),
      );
      const survey = readClaimSet(root);
      expect(survey.live.length).toBe(1);
      expect(claimLiveness(survey.live[0]!)).toBe('live');
      expect(tryAcquireClaim({ root, mode: 'exclusive' }).acquired).toBe(undefined);

      process.kill(grandchild, 'SIGKILL');
      for (let i = 0; i < 200 && readClaimSet(root).live.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(readClaimSet(root).dead.length).toBe(1);
      expect(tryAcquireClaim({ root, mode: 'exclusive' }).acquired).toBeTruthy();
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearing the child record hands liveness back to the owner', () => {
    const got = tryAcquireClaim({ root, mode: 'exclusive' });
    assert(got.acquired);
    markClaimChildPending(got.acquired);
    expect(readClaimSet(root).unresolved.length).toBe(0);
    clearClaimChild(got.acquired);
    expect(readClaimSet(root).live.length).toBe(1);
  });
});

describe('a real race between real processes', { timeout: 30_000 }, () => {
  test('exactly one of six processes takes the claim, and a dead claim does not stop them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-claim-race-'));
    const script = join(dir, 'racer.mjs');
    const url = new URL('../ownership-claim.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { tryAcquireClaim } = await import(${JSON.stringify(url)});`,
        'const got = tryAcquireClaim({ root: process.argv[2], mode: "exclusive", details: { name: process.argv[3] } });',
        'await new Promise((r) => setTimeout(r, 1200));',
        'console.log(JSON.stringify({ acquired: Boolean(got.acquired), held: got.held?.details ?? null }));',
      ].join('\n'),
    );
    plantClaim(root, 'exclusive', goneClaimOwner(), { claimId: 'left-by-a-crash' });

    const run = (name: string) =>
      new Promise<string>((resolve, reject) => {
        const child = getExecutor().spawn(process.execPath, [script, root, name], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += d));
        child.stderr?.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`))));
      });

    try {
      const answers = (await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(run))).map((line) => JSON.parse(line));
      expect(answers.filter((a) => a.acquired).length).toBe(1);
      const losers = answers.filter((a) => !a.acquired);
      expect(losers.length).toBe(5);
      for (const loser of losers) expect(typeof loser.held.name).toBe('string');
      expect(existsSync(join(exclusiveClaimDir(root), 'left-by-a-crash.claim'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a holder killed without releasing leaves a claim the next process takes over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-claim-kill-'));
    const script = join(dir, 'suicide.mjs');
    const url = new URL('../ownership-claim.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { tryAcquireClaim } = await import(${JSON.stringify(url)});`,
        'tryAcquireClaim({ root: process.argv[2], mode: "exclusive" });',
        'process.kill(process.pid, "SIGKILL");',
      ].join('\n'),
    );
    const child = getExecutor().spawn(process.execPath, [script, root], { stdio: 'ignore' });
    await once(child, 'exit');
    try {
      expect(readClaimSet(root).live.length).toBe(0);
      const state = inspectClaimSet(root);
      expect(state.exclusive).toBe(null);
      expect(state.reaped.length).toBe(1);
      expect(tryAcquireClaim({ root, mode: 'exclusive' }).acquired).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
