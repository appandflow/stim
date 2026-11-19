import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configuredWorkers,
  packageManagerFor,
  planTestRun,
  testScriptFor,
  testWorkerCount,
} from '../engine/test-run.ts';

test.each([
  { cores: 4, slots: 1, load1: 0.3, workers: 3, why: 'an idle 4-core machine leaves one core free' },
  {
    cores: 4,
    slots: 1,
    load1: 3.5,
    workers: 3,
    why: "a load under the core count, such as the last run's own workers, does not cut",
  },
  { cores: 4, slots: 1, load1: 8, workers: 1, why: 'a load of twice the cores halves the share' },
  { cores: 14, slots: 2, load1: 2, workers: 6, why: 'two slots split the cores but one' },
  { cores: 14, slots: 2, load1: 28, workers: 3, why: 'a loaded 14-core machine scales each share down' },
  { cores: 1, slots: 1, load1: 40, workers: 1, why: 'never under one worker' },
])('$cores cores, $slots slots, load $load1: $workers workers ($why)', ({ cores, slots, load1, workers }) => {
  expect(testWorkerCount({ cores, slots, load1 })).toBe(workers);
});

test.each([
  {
    name: 'a direct Jest run gets the flag after the jest word',
    argv: ['pnpm', 'exec', 'jest', '--', 'src/a.test.ts'],
    expected: ['pnpm', 'exec', 'jest', '--maxWorkers=3', '--', 'src/a.test.ts'],
    applied: '--maxWorkers=3',
  },
  {
    name: 'a Jest run that sets its own workers is left alone',
    argv: ['npx', 'jest', '-i'],
    expected: ['npx', 'jest', '-i'],
    applied: null,
  },
  {
    name: 'a plain jest test script gets the flag through pnpm without a separator',
    argv: ['pnpm', 'run', 'test'],
    script: 'jest --ci',
    manager: 'pnpm' as const,
    expected: ['pnpm', 'run', 'test', '--maxWorkers=3'],
    applied: '--maxWorkers=3',
  },
  {
    name: 'npm needs the separator to forward the flag to the script',
    argv: ['npm', 'run', 'test'],
    script: 'jest',
    manager: 'npm' as const,
    expected: ['npm', 'run', 'test', '--', '--maxWorkers=3'],
    applied: '--maxWorkers=3',
  },
  {
    name: 'a test script that does more than run jest runs unchanged',
    argv: ['yarn', 'run', 'test'],
    script: 'tsc && jest',
    manager: 'yarn' as const,
    expected: ['yarn', 'run', 'test'],
    applied: null,
  },
  {
    name: 'a project whose Jest config sets maxWorkers keeps it, since the flag would override it',
    argv: ['npx', 'jest'],
    configured: { jest: true, vitest: false },
    expected: ['npx', 'jest'],
    applied: null,
  },
])('$name', ({ argv, script, manager, configured, expected, applied }) => {
  const plan = planTestRun({ argv, workers: 3, env: {}, script, manager, configured });
  expect(plan.argv).toEqual(expected);
  expect(plan.applied).toBe(applied);
  expect(plan.applied === null).toBe(plan.skipped !== null);
});

test.each([
  { name: 'Vitest gets the variable', argv: ['vitest', 'run'], env: {}, variable: '3' },
  {
    name: 'a caller VITEST_MAX_FORKS, which Vitest 3 reads, keeps all three unset',
    argv: ['vitest', 'run'],
    env: { VITEST_MAX_FORKS: '2' },
    variable: undefined,
  },
  { name: 'a caller variable is kept', argv: ['vitest', 'run'], env: { VITEST_MAX_WORKERS: '8' }, variable: undefined },
  {
    name: 'a --maxWorkers flag, which the variable would override, keeps it unset',
    argv: ['vitest', 'run', '--maxWorkers=2'],
    env: {},
    variable: undefined,
  },
  {
    name: 'an unrecognised command still gets it for a Vitest inside',
    argv: ['make', 'check'],
    env: {},
    variable: '3',
  },
])('$name', ({ argv, env, variable }) => {
  const plan = planTestRun({ argv, workers: 3, env });
  expect(plan.argv).toEqual(argv);
  expect(plan.env.VITEST_MAX_WORKERS).toBe(variable);
  expect(plan.env.VITEST_MAX_THREADS).toBe(variable);
  expect(plan.env.VITEST_MAX_FORKS).toBe(variable);
});

test('finds the nearest lockfile, package.json and runner config above the working directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-run-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages', 'app');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(root, 'yarn.lock'), '');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  expect(packageManagerFor(join(pkg, 'src'))).toBe('yarn');
  expect(testScriptFor(join(pkg, 'src'))).toBe('jest');
  expect(configuredWorkers(pkg)).toEqual({ jest: false, vitest: false });
  writeFileSync(join(pkg, 'vitest.config.ts'), 'export default { test: { maxWorkers: 2 } };');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ scripts: {}, jest: { maxWorkers: '50%' } }));
  expect(testScriptFor(pkg)).toBeNull();
  expect(configuredWorkers(join(pkg, 'src'))).toEqual({ jest: true, vitest: true });
});
