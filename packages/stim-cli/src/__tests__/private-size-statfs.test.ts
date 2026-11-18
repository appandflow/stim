import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { diskUsageWalkClaims, readDiskUsagePrivateUnknown } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { measureTree } from '../private-size.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: () => new Promise(() => {}),
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
      if (args.includes('du')) duTimeouts.push(options?.timeoutMs ?? 0);
      return real.runFileAsync(file, args, options);
    },
  });
});

afterEach(() => {
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
