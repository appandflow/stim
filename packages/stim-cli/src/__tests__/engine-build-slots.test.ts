import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimRemoveCommand } from '../ownership-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';
import {
  acquireBuildSlot,
  buildSlotPath,
  buildSlotsDir,
  listBuildSlots,
  releaseBuildSlot,
  readBuildSlot,
  tryAcquireBuildSlot,
} from '../engine/build-slots.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-slots-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('tryAcquireBuildSlot', () => {
  test('takes the first free slot and records the holder', () => {
    const got = tryAcquireBuildSlot({ max: 2, root: '/w/a' });
    assert(got);
    expect(got.acquired).toBe(true);
    expect(got.index).toBe(0);
    expect(existsSync(buildSlotPath(0))).toBeTruthy();
    const rec = readBuildSlot(buildSlotPath(0));
    assert(rec);
    expect(rec.pid).toBe(process.pid);
    expect(rec.index).toBe(0);
    expect(rec.projectRoot).toBe('/w/a');
  });

  test('returns null when every slot is held by a LIVE builder', () => {
    for (const i of [0, 1]) plantClaim(buildSlotPath(i), 'exclusive', liveClaimOwner(), { details: { index: i } });
    expect(tryAcquireBuildSlot({ max: 2 })).toBe(null);
  });

  test('reclaims a slot whose builder is GONE, whatever its age', () => {
    for (const i of [0, 1]) plantClaim(buildSlotPath(i), 'exclusive', goneClaimOwner(), { details: { index: i } });
    const got = tryAcquireBuildSlot({ max: 2 });
    assert(got);
    expect(got.acquired).toBe(true);
    expect(got.index).toBe(0);
  });

  test('a slot whose holder cannot be identified is skipped, waits while another is busy, and refuses when neither', () => {
    const planted = plantClaim(
      buildSlotPath(0),
      'exclusive',
      { pid: 4242, processToken: 'nonsense' },
      { details: { index: 0 } },
    );
    const got = tryAcquireBuildSlot({ max: 2 });
    assert(got);
    expect(got.index).toBe(1);

    releaseBuildSlot(got);
    plantClaim(buildSlotPath(1), 'exclusive', liveClaimOwner(), { details: { index: 1 } });
    expect(tryAcquireBuildSlot({ max: 2 })).toBe(null);

    let err: (Error & { code?: string }) | undefined;
    try {
      tryAcquireBuildSlot({ max: 1 });
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err?.code).toBe('STIM_CLAIM_REFUSED');
    expect(err?.message).toContain(claimRemoveCommand(planted));
  });
});

describe('releaseBuildSlot', () => {
  test('removes our slot', () => {
    const got = tryAcquireBuildSlot({ max: 1 });
    assert(got?.path);
    expect(releaseBuildSlot(got)).toBe(true);
    expect(existsSync(got.path)).toBe(false);
  });

  test('refuses to remove a slot another builder now holds', () => {
    const got = tryAcquireBuildSlot({ max: 1 });
    assert(got?.claim);
    writeFileSync(
      got.claim.path,
      JSON.stringify({ claimId: 'another-builder', mode: 'exclusive', owner: liveClaimOwner(), details: { index: 0 } }),
    );
    expect(releaseBuildSlot(got)).toBe(false);
    expect(existsSync(got.claim.path)).toBeTruthy();
  });

  test('an unlimited handle releases to a no-op', () => {
    expect(releaseBuildSlot({ acquired: true, unlimited: true })).toBe(false);
  });
});

describe('acquireBuildSlot', () => {
  test('unlimited (max 0) acquires immediately without a slot on disk', async () => {
    const got = await acquireBuildSlot({ max: 0 });
    expect(got.unlimited).toBe(true);
    expect(existsSync(buildSlotsDir())).toBe(false);
  });
});

describe('listBuildSlots', () => {
  test('classifies slots by whether the builder is alive', () => {
    plantClaim(buildSlotPath(0), 'exclusive', liveClaimOwner(), { details: { index: 0, projectRoot: '/w/live' } });
    plantClaim(buildSlotPath(1), 'exclusive', goneClaimOwner(), { details: { index: 1, projectRoot: '/w/dead' } });
    const slots = listBuildSlots();
    const byIndex = Object.fromEntries(slots.map((s) => [s.index, s]));
    expect(byIndex[0].alive).toBe(true);
    expect(byIndex[1].alive).toBe(false);
    expect(byIndex[1].projectRoot).toBe('/w/dead');
  });
});

describe('waitForFile', () => {
  test('resolves once the file appears', async () => {
    const path = join(tmpHome, 'late');
    const timer = setTimeout(() => writeFileSync(path, ''), 30);
    try {
      await waitForFile(path);
    } finally {
      clearTimeout(timer);
    }
    expect(existsSync(path)).toBe(true);
  });

  test('gives up with a message naming the file it waited for', async () => {
    const path = join(tmpHome, 'never');
    await expect(waitForFile(path, 50)).rejects.toThrow(`timed out after 50ms waiting for ${path}`);
  });
});

describe('live: 2 slots, 3 processes', { timeout: 30_000 }, () => {
  test('the third process waits for a slot and gets one on release', async () => {
    const script = join(tmpHome, 'holder.mjs');
    const slotsUrl = new URL('../engine/build-slots.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { acquireBuildSlot, releaseBuildSlot } = await import(${JSON.stringify(slotsUrl)});`,
        'const [id, dir] = process.argv.slice(2);',
        'const { writeFileSync, existsSync } = await import("node:fs");',
        'const { join } = await import("node:path");',
        'const handle = await acquireBuildSlot({ max: 2, root: "/w/" + id, intervalMs: 25, progressMs: 1e9 });',
        'writeFileSync(join(dir, "acquired-" + id), String(Date.now()));',
        'while (!existsSync(join(dir, "release-" + id))) {',
        '  await new Promise(r => setTimeout(r, 20));',
        '}',
        'releaseBuildSlot(handle);',
        'writeFileSync(join(dir, "released-" + id), String(Date.now()));',
      ].join('\n'),
    );

    const dir = tmpHome;
    const spawn = (id: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [script, id, dir], { env: { ...process.env, STIM_HOME: tmpHome } }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

    const a = spawn('A');
    const b = spawn('B');
    await waitForFile(join(dir, 'acquired-A'));
    await waitForFile(join(dir, 'acquired-B'));

    const c = spawn('C');
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(join(dir, 'acquired-C'))).toBe(false);

    writeFileSync(join(dir, 'release-A'), '1');
    await waitForFile(join(dir, 'acquired-C'));
    const releasedA = Number(readFileSync(join(dir, 'released-A'), 'utf-8'));
    const acquiredC = Number(readFileSync(join(dir, 'acquired-C'), 'utf-8'));
    expect(acquiredC >= releasedA).toBeTruthy();

    writeFileSync(join(dir, 'release-B'), '1');
    writeFileSync(join(dir, 'release-C'), '1');
    await Promise.all([a, b, c]);
  });
});

async function waitForFile(path: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
