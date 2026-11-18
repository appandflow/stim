import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';

const probes = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const record =
    <A extends unknown[], R>(fn: (path: string, ...rest: A) => R) =>
    (path: string, ...rest: A): R => {
      probes.paths.push(String(path));
      return fn(path, ...rest);
    };
  return {
    ...actual,
    existsSync: record(actual.existsSync as (path: string) => boolean),
    lstatSync: record(actual.lstatSync as (path: string) => unknown),
    statSync: record(actual.statSync as (path: string) => unknown),
  };
});

let base: string;
let tree: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-refresh-sync-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  tree = join(base, 'app', 'node_modules');
  mkdirSync(tree, { recursive: true });
  probes.paths = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const underTree = () => probes.paths.filter((path) => path === tree || path.startsWith(tree + '/'));

it('reads nothing under a dependency tree synchronously when the caller supplies its existence and signature', async () => {
  const options = { timeoutMs: 1000, targets: () => [] as string[] };
  await refreshMeasure(tree, { ...options, knownToExist: true, signature: 'known' });
  expect(underTree()).toEqual([]);
  await refreshMeasure(tree, { ...options, knownToExist: true, signature: 'known' });
  expect(underTree()).toEqual([]);

  await refreshMeasure(tree, { ...options, signature: 'other' });
  await refreshMeasure(tree, options);
  expect(underTree().length).toBeGreaterThan(0);
});
