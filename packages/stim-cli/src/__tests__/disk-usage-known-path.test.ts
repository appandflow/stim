import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refreshMeasure } from '../disk-usage.ts';

const probed = vi.hoisted(() => ({ paths: new Array<string>() }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    existsSync: (path: string) => {
      probed.paths.push(String(path));
      return real.existsSync(path);
    },
  };
});

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-known-path-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  dir = join(base, 'out');
  mkdirSync(dir);
  writeFileSync(join(dir, 'x'), 'x');
  probed.paths.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

it('probes the folder with existsSync unless the caller established that it exists', async () => {
  await refreshMeasure(dir, { timeoutMs: 10_000, private: false });
  expect(probed.paths).toContain(dir);
  probed.paths.length = 0;
  rmSync(join(base, 'home'), { recursive: true, force: true });
  const { outcome } = await refreshMeasure(dir, { timeoutMs: 10_000, private: false, knownToExist: true });
  expect(outcome).toBe('measured');
  expect(probed.paths).not.toContain(dir);
});
