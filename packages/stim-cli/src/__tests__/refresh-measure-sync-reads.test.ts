import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn<typeof actual.existsSync>(actual.existsSync),
    lstatSync: vi.fn<typeof actual.lstatSync>(actual.lstatSync),
    statSync: vi.fn<typeof actual.statSync>(actual.statSync),
  };
});

let base: string;
let tree: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-refresh-sync-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  tree = join(base, 'app', 'node_modules');
  mkdirSync(tree, { recursive: true });
  vi.mocked(existsSync).mockClear();
  vi.mocked(lstatSync).mockClear();
  vi.mocked(statSync).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const probed = () =>
  [existsSync, lstatSync, statSync].flatMap((fn) => vi.mocked(fn).mock.calls.map(([path]) => String(path)));
const underTree = () => probed().filter((path) => path === tree || path.startsWith(tree + '/'));

it('reads nothing under a dependency tree synchronously when the caller supplies its existence and signature', async () => {
  const options = { timeoutMs: 1000, targets: (): string[] => [] };
  await refreshMeasure(tree, { ...options, knownToExist: true, signature: 'known' });
  expect(underTree()).toEqual([]);
  await refreshMeasure(tree, { ...options, knownToExist: true, signature: 'known' });
  expect(underTree()).toEqual([]);

  await refreshMeasure(tree, { ...options, signature: 'other' });
  await refreshMeasure(tree, options);
  expect(underTree().length).toBeGreaterThan(0);
});
