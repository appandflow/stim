import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { diskUsageWalkClaims, readDiskUsagePrivateUnknown } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { measureTree, privateSizeKnowable } from '../private-size.ts';
import { testContext } from './_context.ts';

const reads = vi.hoisted(() => new Array<(answer: { type: number }) => void>());
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: () =>
    new Promise((settle) => {
      reads.push(settle);
    }),
}));

let base: string;
let duTimeouts: number[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-statfs-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  duTimeouts = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      if (file === 'du' || args.includes('du')) duTimeouts.push(options?.timeoutMs ?? 0);
      return real.runFileAsync(file, args, options);
    },
  });
});

afterEach(async () => {
  for (const settle of reads.splice(0)) settle({ type: 0 });
  await new Promise((done) => setImmediate(done));
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function tree(name: string): string {
  const path = join(base, name, 'node_modules');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'index.js'), 'x');
  return path;
}

test.runIf(process.platform === 'linux')('an abort while statfs has not answered ends the walk at once', async () => {
  const controller = new AbortController();
  const measuring = measureTree(tree('stalled'), {
    timeoutMs: 30_000,
    operation: testContext({ signal: controller.signal }),
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();

  await expect(measuring).rejects.toMatchObject({ name: 'AbortError' });
  expect(duTimeouts).toEqual([]);
});

test.runIf(process.platform === 'linux')(
  'a statfs that does not answer leaves du the whole walk time, marks only that tree and frees the walk claim',
  async () => {
    const stalled = tree('stalled');
    const measuring = refreshMeasure(stalled, { timeoutMs: 30_000, claim: true });
    await vi.advanceTimersByTimeAsync(2000);
    const { outcome, measure } = await measuring;

    expect(outcome).toBe('measured');
    expect(measure?.privateBytes).toBeUndefined();
    expect(readDiskUsagePrivateUnknown(stalled)).toBe('walk');
    expect(duTimeouts).toEqual([30_000]);
    const claim = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'disk usage walk' });
    expect(claim.acquired).toBeDefined();
    releaseClaim(claim.acquired ?? null);

    const healthy = tree('healthy');
    expect((await refreshMeasure(healthy, { timeoutMs: 30_000 })).outcome).toBe('measured');
    expect(readDiskUsagePrivateUnknown(healthy)).toBeNull();
  },
);

const settled = () => new Promise((done) => setImmediate(done));

test.runIf(process.platform === 'linux')(
  'concurrent probes on a healthy volume all answer, their native reads strictly one at a time',
  async () => {
    const probes = ['a', 'b', 'c', 'd'].map((name) => privateSizeKnowable(tree(name)));
    for (let read = 0; read < probes.length; read++) {
      await settled();
      expect(reads).toHaveLength(1);
      reads.splice(0)[0]?.({ type: 0xef53 });
    }
    expect(await Promise.all(probes)).toEqual(['yes', 'yes', 'yes', 'yes']);
  },
);

test.runIf(process.platform === 'linux')(
  'probes queued behind a stalled read are busy after the probe limit, and no second native read starts',
  async () => {
    const probes = ['a', 'b', 'c', 'd'].map((name) => privateSizeKnowable(tree(name)));
    await settled();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await Promise.all(probes)).toEqual(['timeout', 'busy', 'busy', 'busy']);
    expect(reads).toHaveLength(1);
    expect(await privateSizeKnowable(tree('e'))).toBe('busy');
    expect(reads).toHaveLength(1);
  },
);
