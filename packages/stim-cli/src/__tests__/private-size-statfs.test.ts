import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { diskUsageWalkClaims } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: () => new Promise(() => {}),
}));

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-statfs-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test.runIf(process.platform === 'linux')(
  'a volume whose statfs never answers leaves the tree of unknown private size by the deadline and releases the walk claim',
  async () => {
    const tree = join(base, 'node_modules');
    mkdirSync(tree);
    writeFileSync(join(tree, 'index.js'), 'x');

    const measuring = refreshMeasure(tree, { timeoutMs: 30_000, claim: true });
    await vi.advanceTimersByTimeAsync(30_000);
    const { outcome, measure } = await measuring;

    expect(outcome).toBe('measured');
    expect(measure?.privateBytes).toBeUndefined();
    const claim = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'disk usage walk' });
    expect(claim.acquired).toBeDefined();
    releaseClaim(claim.acquired ?? null);
  },
);
