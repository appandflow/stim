import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { diskUsageWalkClaims, readDiskUsage, readDiskUsageFailure } from '@stim-cli/core/state';
import { knownPrivateBytes, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

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
      if (file !== 'nice') return real.runFileAsync(file, args, opts);
      walks++;
      return failing ? Promise.reject(new Error('Command timed out')) : real.runFileAsync(file, args, opts);
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
