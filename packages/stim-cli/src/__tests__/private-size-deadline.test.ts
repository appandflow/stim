import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { measureTree } from '../private-size.ts';

const setup = vi.hoisted(() => ({ takesMs: 0, budgets: new Array<number | undefined>() }));
vi.mock('../clonefile.ts', async (original) => ({
  ...(await original<typeof import('../clonefile.ts')>()),
  privateSizeHelper: async (_operation: unknown, timeoutMs?: number) => {
    setup.budgets.push(timeoutMs);
    vi.setSystemTime(Date.now() + setup.takesMs);
    return null;
  },
}));

let base: string;
let walkTimeouts: number[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-measure-deadline-'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  setup.budgets = [];
  walkTimeouts = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      walkTimeouts.push(options?.timeoutMs ?? 0);
      return real.runFileAsync(file, args, options);
    },
  });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function tree(): string {
  const path = join(base, 'node_modules');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'index.js'), 'x');
  return path;
}

test('helper setup counts against the walk timeout: the walk gets what remains, and none starts once it is spent', async () => {
  const path = tree();
  setup.takesMs = 100_000;
  expect(await measureTree(path, { timeoutMs: 120_000 })).not.toBeNull();
  expect(setup.budgets).toEqual([120_000]);
  expect(walkTimeouts).toEqual([20_000]);

  walkTimeouts = [];
  setup.takesMs = 130_000;
  expect(await measureTree(path, { timeoutMs: 120_000 })).toBeNull();
  expect(walkTimeouts).toEqual([]);
});
