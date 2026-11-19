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

const pnpm = 'pnpm' as const;

test.each([
  {
    name: 'a direct Jest run gets the flag before its -- separator',
    argv: ['pnpm', 'exec', 'jest', '--', 'src/a.test.ts'],
    expected: ['pnpm', 'exec', 'jest', '--maxWorkers=3', '--', 'src/a.test.ts'],
  },
  {
    name: 'a direct Vitest run gets the flag too',
    argv: ['vitest', 'run'],
    expected: ['vitest', 'run', '--maxWorkers=3'],
  },
  { name: 'a Jest run that sets its own workers is left alone', argv: ['npx', 'jest', '-i'], expected: null },
  { name: 'a Jest run naming another config is left alone', argv: ['jest', '-c', 'jest.e2e.js'], expected: null },
  { name: 'a Vitest run naming another config is left alone', argv: ['vitest', '--config', 'x.ts'], expected: null },
  {
    name: 'a plain jest test script gets the flag through pnpm without a separator',
    argv: ['pnpm', 'run', 'test'],
    script: 'jest --ci',
    manager: pnpm,
    expected: ['pnpm', 'run', 'test', '--maxWorkers=3'],
  },
  {
    name: 'npm needs the separator to forward the flag to the script',
    argv: ['npm', 'run', 'test'],
    script: 'vitest run',
    manager: 'npm' as const,
    expected: ['npm', 'run', 'test', '--', '--maxWorkers=3'],
  },
  {
    name: 'a script with its own -- would read the flag as a path, so it runs unchanged',
    argv: ['pnpm', 'run', 'test'],
    script: 'jest -- src',
    manager: pnpm,
    expected: null,
  },
  {
    name: 'a monorepo script runs unchanged',
    argv: ['pnpm', 'run', 'test'],
    script: 'pnpm -r test',
    manager: pnpm,
    expected: null,
  },
  {
    name: 'a project whose Vitest config may run serially keeps it',
    argv: ['vitest', 'run'],
    configured: { jest: false, vitest: true },
    expected: null,
  },
  { name: 'an unrecognised command runs unchanged', argv: ['turbo', 'run', 'test'], expected: null },
])('$name', ({ argv, script, manager, configured, expected }) => {
  const plan = planTestRun({ argv, workers: 3, script, manager, configured });
  expect(plan.argv).toEqual(expected ?? argv);
  expect(plan.applied).toBe(expected ? '--maxWorkers=3' : null);
  expect(plan.applied === null).toBe(plan.skipped !== null);
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
  writeFileSync(join(root, 'vitest.config.ts'), 'export default { test: { fileParallelism: false } };');
  expect(configuredWorkers(join(pkg, 'src'))).toEqual({ jest: false, vitest: false });
  writeFileSync(join(pkg, 'vitest.config.ts'), 'export default { test: { fileParallelism: false } };');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ scripts: {}, jest: { maxWorkers: '50%' } }));
  expect(testScriptFor(pkg)).toBeNull();
  expect(configuredWorkers(join(pkg, 'src'))).toEqual({ jest: true, vitest: true });
});
