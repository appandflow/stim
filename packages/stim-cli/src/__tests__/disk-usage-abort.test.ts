import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';
import { testContext } from './_context.ts';

const walk = vi.hoisted(() => ({ calls: 0, abort: () => {} }));
vi.mock('../private-size.ts', async (original) => ({
  ...(await original<typeof import('../private-size.ts')>()),
  measureTree: async () => {
    walk.calls++;
    walk.abort();
    throw new Error('walk stopped');
  },
}));

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-abort-walk-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  walk.calls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('a walk cut short by an abort leaves a failure record that the next measurement of the same install honours', async () => {
  const tree = join(base, 'node_modules');
  mkdirSync(tree);
  const controller = new AbortController();
  walk.abort = () => controller.abort();

  await expect(
    refreshMeasure(tree, { timeoutMs: 60_000, failures: true, operation: testContext({ signal: controller.signal }) }),
  ).rejects.toThrow('walk stopped');
  const again = await refreshMeasure(tree, { timeoutMs: 60_000, failures: true });

  expect(walk.calls).toBe(1);
  expect(again).toEqual({ outcome: 'fresh', measure: null });
});
