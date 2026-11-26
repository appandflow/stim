import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { takeLock } from '../engine-store/locks.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { withFingerprintOwnership } from '../engine/fingerprint-ownership.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn, trackClaimActivity } from '../engine/spawn-claims.ts';
import { claimFailure, readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { testContext } from './_context.ts';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../daemon/engine-switch.ts', async (original) => ({
  ...(await original<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: () => ({ root: fixture.root, build: '0123456789ab' }),
}));

test('a selected engine stays claimed until pre-existing declared work settles', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const root = join(area, 'project');
  mkdirSync(root);
  const home = join(area, 'home');
  const context = testContext({ home, projectRoot: root });
  const native = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
  }).acquired;
  if (!native) throw new Error('fixture did not acquire native-run');
  declareSpawnsOn(context, native);
  const activity = trackClaimActivity(native);
  let observed!: () => void;
  const ready = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const running = withFingerprintOwnership(context, root, async () => {
    observed();
    return 'done';
  });
  try {
    await Promise.race([
      ready,
      running.then(() => {
        throw new Error('ownership ended before the callback');
      }),
    ]);
    const engineRoot = buildClaimRoot(fixture.root, '0123456789ab');
    expect(readClaimSet(engineRoot).live).toHaveLength(1);
    activity.settle();
    expect(await running).toBe('done');
    expect(readClaimSet(engineRoot).live).toEqual([]);
  } finally {
    activity.settle();
    await running.catch(() => {});
    stopDeclaringSpawnsOn(context, native);
    releaseClaim(native);
    rmSync(area, { recursive: true, force: true });
  }
});

test.each([
  ['plain object', () => ({ reportCleanup: true, remedy: 'fixture cleanup could not be verified' })],
  [
    'Error',
    () =>
      Object.assign(new Error('fixture cleanup failed'), {
        reportCleanup: true,
        remedy: 'fixture cleanup could not be verified',
      }),
  ],
] as const)('a marked %s cleanup failure retains only the native claim', async (_kind, failure) => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const root = join(area, 'project');
  const home = join(area, 'home');
  mkdirSync(root);
  const context = testContext({ home, projectRoot: root });
  try {
    await expect(
      withFingerprintOwnership(context, root, async () => {
        throw failure();
      }),
    ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    const native = join(home, 'workspaces', workspaceName(root), 'native-run.lock');
    expect(readClaimSet(native).live).toEqual(
      expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
    );
    expect(readClaimSet(buildClaimRoot(fixture.root, '0123456789ab'))).toMatchObject({ live: [], unresolved: [] });
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test('concurrent fingerprints wait for engine admission and release their claims', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const home = join(area, 'home');
  let settled = false;
  const running = Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => {
      const root = join(area, `project-${index}`);
      mkdirSync(root);
      return withFingerprintOwnership(testContext({ home, projectRoot: root }), root, async () => index);
    }),
  ).then((results) => {
    settled = true;
    return results;
  });
  try {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (settled) break;
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(settled).toBe(true);
    expect(await running).toEqual(Array.from({ length: 8 }, (_, index) => ({ status: 'fulfilled', value: index })));
    expect(readClaimSet(buildClaimRoot(fixture.root, '0123456789ab')).live).toEqual([]);
  } finally {
    await running;
    rmSync(area, { recursive: true, force: true });
  }
});

test('engine admission times out after ten seconds while the store lock stays held', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const root = join(area, 'project');
  mkdirSync(root);
  const work = vi.fn<() => Promise<string>>(async () => 'done');
  const lock = await takeLock(fixture.root, '.lock.sock');
  const started = Date.now();
  let settled = false;
  const running = withFingerprintOwnership(testContext({ home: join(area, 'home'), projectRoot: root }), root, work)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error, elapsed: Date.now() - started }),
    )
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    expect(lock).not.toBeNull();
    for (let attempt = 0; attempt < 240; attempt++) {
      if (settled) break;
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(settled).toBe(true);
    const result = await running;
    expect(result).toMatchObject({
      error: {
        code: 'STIM_CLAIM_UNAVAILABLE',
        message: expect.stringContaining('the engine store is busy'),
        remedy: 'Wait a few seconds while another Stim command uses or switches the engine',
      },
      elapsed: expect.any(Number),
    });
    if (!('elapsed' in result)) throw new Error('fingerprint unexpectedly ran');
    expect(claimFailure(result.error, null)?.remedy).toBe(
      'Wait a few seconds while another Stim command uses or switches the engine, then retry the same Stim command.',
    );
    expect(result.elapsed).toBeGreaterThanOrEqual(10_000);
    expect(work).not.toHaveBeenCalled();
  } finally {
    await lock?.release();
    await running;
    rmSync(area, { recursive: true, force: true });
  }
});

test('an unavailable engine refuses fingerprinting with engine status guidance', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const root = join(area, 'project');
  const context = testContext({ home: join(area, 'home'), projectRoot: root });
  try {
    await expect(withFingerprintOwnership(context, root, async () => 'done')).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      remedy: 'Run stim engine status to check the selected, previous and staged engine builds',
    });
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test('a fingerprint refuses at once, naming the run that holds the workspace', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const root = join(area, 'project');
  mkdirSync(root);
  const home = join(area, 'home');
  const native = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
    details: { command: 'ios', platform: 'ios', slot: 'default' },
  }).acquired;
  if (!native) throw new Error('fixture did not acquire native-run');
  const work = vi.fn<() => Promise<string>>(async () => 'done');
  try {
    await expect(withFingerprintOwnership(testContext({ home, projectRoot: root }), root, work)).rejects.toMatchObject({
      code: 'STIM_LOCK_REFUSED',
      message: expect.stringContaining(`held by \`stim ios\` (pid ${process.pid}`),
      remedy: 'Run the command again after it finishes.',
    });
    expect(work).not.toHaveBeenCalled();
    expect(readClaimSet(buildClaimRoot(fixture.root, '0123456789ab')).live).toEqual([]);
  } finally {
    releaseClaim(native);
    rmSync(area, { recursive: true, force: true });
  }
});
