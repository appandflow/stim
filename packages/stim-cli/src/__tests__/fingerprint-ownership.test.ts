import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { withFingerprintOwnership } from '../engine/fingerprint-ownership.ts';
import { declareSpawnsOn, spawnDeclared, stopDeclaringSpawnsOn, trackClaimActivity } from '../engine/spawn-claims.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { testContext } from './_context.ts';
import { makeChildProcess } from './_factories.ts';

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

test('a fingerprint evaluation aborted while its child runs releases the native claim', async () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-fingerprint-owner-'));
  fixture.root = join(area, 'store');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const root = join(area, 'project');
  mkdirSync(root);
  const home = join(area, 'home');
  const controller = new AbortController();
  const context = testContext({ home, projectRoot: root });
  const native = join(home, 'workspaces', workspaceName(root), 'native-run.lock');
  try {
    await expect(
      withFingerprintOwnership(
        context,
        root,
        async () => {
          const child = spawnDeclared(context, () => makeChildProcess({ pid: process.pid }));
          expect(readClaimSet(native).live[0]?.child).toMatchObject({ pid: process.pid });
          controller.abort(new Error('stimd is ending'));
          child.emit('exit', null, 'SIGTERM');
          controller.signal.throwIfAborted();
        },
        controller.signal,
      ),
    ).rejects.toThrow('stimd is ending');
    expect(readClaimSet(native)).toMatchObject({ live: [], dead: [], unresolved: [] });
    expect(existsSync(native)).toBe(false);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
