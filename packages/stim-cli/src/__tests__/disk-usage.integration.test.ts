import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  diskUsageCacheFile,
  diskUsageFailureFile,
  diskUsageWalkClaims,
  readDiskUsage,
  readDiskUsageFailure,
  readJsonObject,
} from '@stim-cli/core/state';
import { knownPrivateBytes, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { backgroundWalk } from './_background-walk.ts';

let scratch: string;
let tree: string;
let walks: number;
let failing: boolean;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-disk-usage-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'home'));
  tree = join(scratch, 'app', 'node_modules');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'blob'), Buffer.alloc(200_000, 1));
  walks = 0;
  failing = false;
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, opts) => {
      if (!backgroundWalk(file, args)) return real.runFileAsync(file, args, opts);
      walks++;
      return failing
        ? Promise.reject(Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' }))
        : real.runFileAsync(file, args, opts);
    },
  });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const options = { timeoutMs: 60_000 };

test('a dependency tree is walked once, served from the cache while its install is unchanged, and walked again after a reinstall', async () => {
  const first = await refreshMeasure(tree, options);
  expect(first.outcome).toBe('measured');
  expect(first.measure?.bytes).toBeGreaterThanOrEqual(200_000);
  expect(trustedMeasure(tree)).toEqual(first.measure);
  const walked = walks;

  expect((await refreshMeasure(tree, options)).outcome).toBe('fresh');
  expect(walks).toBe(walked);

  writeFileSync(join(tree, '.modules.yaml'), 'layoutVersion: 5\n');
  expect(trustedMeasure(tree)).toBeNull();
  expect(knownPrivateBytes(tree)).toBeNull();
  expect(readDiskUsage(tree)).not.toBeNull();

  const again = await refreshMeasure(tree, options);
  expect(again.outcome).toBe('measured');
  expect(walks).toBeGreaterThan(walked);
  expect(trustedMeasure(tree)?.signature).toBe(again.measure?.signature);
  expect(again.measure?.signature).not.toBe(first.measure?.signature);
}, 120_000);

test('a dependency tree that does not exist is measured as empty until it appears', async () => {
  const missing = join(scratch, 'other', 'node_modules');

  const absent = await refreshMeasure(missing, options);

  expect(absent.measure).toMatchObject({ bytes: 0, privateBytes: 0 });
  expect(trustedMeasure(missing)).toEqual(absent.measure);
  expect(walks).toBe(0);
  mkdirSync(missing, { recursive: true });
  expect(trustedMeasure(missing)).toBeNull();
});

test('a failed walk is recorded and not repeated until the folder is due again, and records nothing when failures are off', async () => {
  const plain = join(scratch, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'blob'), Buffer.alloc(10_000));
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  const now = () => clock;
  failing = true;

  const failed = await refreshMeasure(plain, { ...options, maxAgeMs: 60_000, now, failures: true });

  expect(failed).toEqual({ outcome: 'failed', measure: null });
  expect(readDiskUsage(plain)).toBeNull();
  expect(readDiskUsageFailure(plain)).toBe(new Date(clock).toISOString());
  expect(readJsonObject(diskUsageFailureFile(plain))).toMatchObject({ reason: 'timeout', limitMs: 60_000 });
  const walked = walks;
  expect((await refreshMeasure(plain, { ...options, maxAgeMs: 60_000, now, failures: true })).outcome).toBe('fresh');
  expect(walks).toBe(walked);

  clock += 60_000;
  failing = false;
  expect((await refreshMeasure(plain, { ...options, maxAgeMs: 60_000, now, failures: true })).outcome).toBe('measured');

  const quiet = join(scratch, 'quiet');
  mkdirSync(quiet);
  failing = true;
  await refreshMeasure(quiet, { ...options, maxAgeMs: 60_000 });
  expect(readDiskUsageFailure(quiet)).toBeNull();
});

test('a walk claim held elsewhere leaves the folder unmeasured, and the walk runs once it is released', async () => {
  const held = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'test walk' }).acquired;
  if (!held) throw new Error('the test could not take the walk claim');

  const busy = await refreshMeasure(tree, { ...options, claim: true });

  expect(busy).toEqual({ outcome: 'busy', measure: null });
  expect(walks).toBe(0);
  releaseClaim(held);
  expect((await refreshMeasure(tree, { ...options, claim: true })).outcome).toBe('measured');
}, 120_000);

test('settled runs while the walk claim is still held, after a walk and after a failed one', async () => {
  const heldDuringSettled: boolean[] = [];
  const settled = () => {
    const attempt = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'test walk' });
    heldDuringSettled.push(!attempt.acquired);
    if (attempt.acquired) releaseClaim(attempt.acquired);
  };

  expect((await refreshMeasure(tree, { ...options, claim: true, settled })).outcome).toBe('measured');
  expect(
    (
      await refreshMeasure(join(tree, 'missing'), {
        ...options,
        claim: true,
        knownToExist: true,
        failures: true,
        settled,
      })
    ).outcome,
  ).toBe('failed');

  expect(heldDuringSettled).toEqual([true, true]);
  const after = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'test walk' }).acquired;
  expect(after).toBeTruthy();
  if (after) releaseClaim(after);
}, 120_000);

test('a claimed walk whose child exits before its identity can be recorded is still measured', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, opts) =>
      real.runFileAsync(file, args, {
        ...opts,
        onSpawn: (child) => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          opts?.onSpawn?.(child);
        },
      }),
  });

  const result = await refreshMeasure(tree, { ...options, claim: true });

  expect(result.outcome).toBe('measured');
});

test('a walk records how long it took, and an entry written without it still reads', async () => {
  const plain = join(scratch, 'timed');
  mkdirSync(plain);
  writeFileSync(join(plain, 'blob'), Buffer.alloc(10_000));
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, opts) => {
      if (backgroundWalk(file, args)) clock += 1234;
      return real.runFileAsync(file, args, opts);
    },
  });

  const walked = await refreshMeasure(plain, { ...options, now: () => clock, claim: true });

  expect(walked.outcome).toBe('measured');
  expect(readJsonObject(diskUsageCacheFile(plain))?.walkMs).toBe(1234);
  expect(readDiskUsage(plain)).toEqual(walked.measure);

  const { walkMs: _walkMs, ...legacy } = JSON.parse(readFileSync(diskUsageCacheFile(plain), 'utf8'));
  writeFileSync(diskUsageCacheFile(plain), JSON.stringify(legacy));
  expect(readJsonObject(diskUsageCacheFile(plain))?.walkMs).toBeUndefined();
  expect(readDiskUsage(plain)).toEqual(walked.measure);
  expect((await refreshMeasure(plain, { ...options, now: () => clock })).outcome).toBe('fresh');
});

test('a walk whose du exited with status 1 is recorded as partial, a later complete walk clears it, and an entry without the field reads as complete', async () => {
  const plain = join(scratch, 'partial');
  mkdirSync(plain);
  writeFileSync(join(plain, 'blob'), Buffer.alloc(10_000));
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  let denied = true;
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, opts) => {
      if (denied && (file === 'du' || args.includes('du')))
        return Promise.reject(Object.assign(new Error('du: Permission denied'), { status: 1, stdout: '8\t/walked\n' }));
      return real.runFileAsync(file, args, opts);
    },
  });
  const walk = (extra = {}) =>
    refreshMeasure(plain, { ...options, private: false, maxAgeMs: 60_000, now: () => clock, ...extra });

  const first = await walk();
  expect(first).toMatchObject({ outcome: 'measured', partial: true });
  expect(readJsonObject(diskUsageCacheFile(plain))?.partial).toBe(true);
  expect(await walk()).toMatchObject({ outcome: 'fresh', partial: true });

  clock += 120_000;
  denied = false;
  const second = await walk();
  expect(second.outcome).toBe('measured');
  expect(second).not.toHaveProperty('partial');
  expect(readJsonObject(diskUsageCacheFile(plain))?.partial).toBeUndefined();

  const { partial: _partial, ...legacy } = {
    ...JSON.parse(readFileSync(diskUsageCacheFile(plain), 'utf8')),
    partial: true,
  };
  writeFileSync(diskUsageCacheFile(plain), JSON.stringify(legacy));
  expect(await walk()).not.toHaveProperty('partial');
});
