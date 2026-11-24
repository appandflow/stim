import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configuredWorkers,
  installedVitestVersion,
  packageManagerFor,
  planTestRun,
  testScriptFor,
  testWorkerCount,
  vitestVersionFor,
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
  { cores: 8, slots: 4, load1: 16, fixed: 2, workers: 2, why: 'concurrency.testWorkers is not cut by the load' },
  { cores: 8, slots: 1, load1: 0, fixed: 12, workers: 12, why: 'concurrency.testWorkers is not capped by the cores' },
])('$cores cores, $slots slots, load $load1: $workers workers ($why)', ({ cores, slots, load1, fixed, workers }) => {
  expect(testWorkerCount({ cores, slots, load1, fixed })).toBe(workers);
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
  ...['-c./jest.e2e.config.js', '-w50%', '-w2', '-ui', '-ci'].map((word) => ({
    name: `a Jest short option with an attached value or in a cluster, ${word}, is left alone`,
    argv: ['jest', word],
    expected: null,
  })),
  ...['-c./vitest.e2e.ts', '-r./app'].map((word) => ({
    name: `a Vitest short option with an attached value, ${word}, is left alone`,
    argv: ['vitest', 'run', word],
    expected: null,
  })),
  { name: 'a Jest -u still gets the flag', argv: ['jest', '-u'], expected: ['jest', '-u', '--maxWorkers=3'] },
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
  ...['jest\nnode --version', 'jest; node --version', 'jest && node --version'].map((script) => ({
    name: `a multi-command script ${JSON.stringify(script)} runs unchanged`,
    argv: ['pnpm', 'run', 'test'],
    script,
    manager: pnpm,
    expected: null,
  })),
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
  {
    name: 'yarn exec drops the options after the binary, so it runs unchanged',
    argv: ['yarn', 'exec', 'jest'],
    expected: null,
  },
  { name: 'yarn drops the words before a --, so it runs unchanged', argv: ['yarn', 'jest', '--', 'a'], expected: null },
  {
    name: 'yarn without a -- forwards the flag',
    argv: ['yarn', 'jest', '--ci'],
    expected: ['yarn', 'jest', '--ci', '--maxWorkers=3'],
  },
  {
    name: 'a Vitest --minWorkers keeps the count out',
    argv: ['npx', 'vitest', 'run', '--minWorkers=4'],
    expected: null,
  },
  {
    name: 'pnpm jest runs a script named jest when there is one, so it is not a direct run',
    argv: ['pnpm', 'jest'],
    scripts: ['jest', 'test'],
    expected: null,
  },
  {
    name: 'Vitest 3.2.3 and earlier also get --minWorkers=1, since they default it to the cores but one',
    argv: ['vitest', 'run'],
    vitestVersion: '3.2.3',
    expected: ['vitest', 'run', '--maxWorkers=3', '--minWorkers=1'],
    applied: '--maxWorkers=3 --minWorkers=1',
  },
  {
    name: 'a Vitest 2 test script gets both flags through npm',
    argv: ['npm', 'run', 'test'],
    script: 'vitest run',
    manager: 'npm' as const,
    vitestVersion: '2.1.9',
    expected: ['npm', 'run', 'test', '--', '--maxWorkers=3', '--minWorkers=1'],
    applied: '--maxWorkers=3 --minWorkers=1',
  },
  {
    name: 'Vitest 3.2.4 gets only --maxWorkers',
    argv: ['vitest'],
    vitestVersion: '3.2.4',
    expected: ['vitest', '--maxWorkers=3'],
  },
  {
    name: 'Vitest 4 gets only --maxWorkers',
    argv: ['vitest'],
    vitestVersion: '4.0.0',
    expected: ['vitest', '--maxWorkers=3'],
  },
  { name: 'Vitest before 1.3 runs unchanged', argv: ['vitest'], vitestVersion: '1.2.2', expected: null },
  { name: 'Vitest with no readable version runs unchanged', argv: ['vitest'], vitestVersion: null, expected: null },
  {
    name: 'Jest needs no Vitest version',
    argv: ['jest'],
    vitestVersion: null,
    expected: ['jest', '--maxWorkers=3'],
  },
  {
    name: 'node --test gets --test-concurrency right after --test, since node ignores options after a test file',
    argv: ['node', '--import', 'tsx', '--test', 'src/'],
    expected: ['node', '--import', 'tsx', '--test', '--test-concurrency=3', 'src/'],
    applied: '--test-concurrency=3',
  },
  { name: 'a --test after the script is the script argument', argv: ['node', 'run.js', '--test'], expected: null },
  {
    name: 'node --test with its own concurrency is left alone',
    argv: ['node', '--test', '--test-concurrency=1'],
    expected: null,
  },
  {
    name: 'NODE_OPTIONS setting the concurrency keeps the count out',
    argv: ['node', '--test'],
    nodeOptions: '--test-concurrency=2',
    expected: null,
  },
  {
    name: 'a node --test script with no test file gets the flag appended',
    argv: ['npm', 'run', 'test'],
    script: 'node --test --test-reporter spec',
    manager: 'npm' as const,
    expected: ['npm', 'run', 'test', '--', '--test-concurrency=3'],
    applied: '--test-concurrency=3',
  },
  {
    name: 'a node --test script naming test files runs unchanged, since an appended option would come after them',
    argv: ['pnpm', 'run', 'test'],
    script: 'node --test src/',
    manager: pnpm,
    expected: null,
  },
  {
    name: 'script arguments follow the flag, with one separator for npm',
    argv: ['npm', 'run', 'test'],
    script: 'jest --ci',
    manager: 'npm' as const,
    extra: ['src/a.test.ts', '--', 'x'],
    expected: ['npm', 'run', 'test', '--', '--maxWorkers=3', 'src/a.test.ts', '--', 'x'],
  },
  {
    name: 'script arguments that set the workers keep the count out, and still reach the script',
    argv: ['npm', 'run', 'test'],
    script: 'jest --ci',
    manager: 'npm' as const,
    extra: ['-i'],
    expected: ['npm', 'run', 'test', '--', '-i'],
    applied: null,
  },
])('$name', ({ argv, script, manager, configured, scripts, vitestVersion, extra, nodeOptions, expected, applied }) => {
  const plan = planTestRun({
    argv,
    workers: 3,
    script,
    manager,
    extra,
    configured,
    scripts,
    nodeOptions,
    vitestVersion: vitestVersion === undefined ? '5.0.4' : vitestVersion,
  });
  expect(plan.argv).toEqual(expected ?? argv);
  expect(plan.applied).toBe(applied !== undefined ? applied : expected ? '--maxWorkers=3' : null);
  expect(plan.applied === null).toBe(plan.skipped !== null);
});

test.each([
  { file: 'jest.config.json', text: '{"maxWorkers":1}', expected: { jest: true, vitest: false } },
  { file: 'jest.config.json', text: '{"testEnvironment":"node"}', expected: { jest: false, vitest: false } },
  { file: 'jest.config.js', text: 'module.exports = { maxWorkers: 2 };', expected: { jest: true, vitest: false } },
  { file: 'jest.config.cjs', text: "module.exports = { preset: 'ts-jest' };", expected: { jest: true, vitest: false } },
  {
    file: 'jest.config.js',
    text: "module.exports = { preset: 'react-native', setupFiles: [require.resolve('./setup.js')] };",
    expected: { jest: false, vitest: false },
  },
  {
    file: 'jest.config.js',
    text: "module.exports = { preset: 'jest-expo' };",
    expected: { jest: false, vitest: false },
  },
  {
    file: 'jest.config.js',
    text: "module.exports = { preset: 'jest-expo/universal' };",
    expected: { jest: true, vitest: false },
  },
  {
    file: 'jest.config.js',
    text: "module.exports = require('@acme/jest-config');",
    expected: { jest: true, vitest: false },
  },
  {
    file: 'jest.config.js',
    text: 'module.exports = require(process.env.JEST_CONFIG);',
    expected: { jest: true, vitest: false },
  },
  {
    file: 'jest.config.ts',
    text: "import type { Config } from 'jest'; const config: Config = { verbose: true }; export default config;",
    expected: { jest: false, vitest: false },
  },
  {
    file: 'jest.config.ts',
    text: "import { createDefaultPreset } from 'ts-jest'; export default { ...createDefaultPreset() };",
    expected: { jest: true, vitest: false },
  },
  {
    file: 'vitest.config.ts',
    text: "import shared from '@acme/vitest-config'; export default shared;",
    expected: { jest: false, vitest: true },
  },
  {
    file: 'vitest.config.ts',
    text: "import { configDefaults, defineConfig } from 'vitest/config'; import { resolve } from 'node:path'; export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'e2e/**'], root: resolve('.') } });",
    expected: { jest: false, vitest: false },
  },
  {
    file: 'jest.config.mjs',
    text: "import base from './base.mjs'; export default base;",
    expected: { jest: true, vitest: false },
  },
  { file: 'jest.config.ts', text: 'export default { verbose: true };', expected: { jest: false, vitest: false } },
  {
    file: 'vitest.config.ts',
    text: "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { minWorkers: 4 } });",
    expected: { jest: false, vitest: true },
  },
  {
    file: 'vite.config.mts',
    text: "import { defineConfig } from 'vite'; export default defineConfig({ test: { globals: true } });",
    expected: { jest: false, vitest: false },
  },
  {
    file: 'vite.config.js',
    text: "import shared from './shared.js'; export default { ...shared, test: {} };",
    expected: { jest: false, vitest: true },
  },
  { file: 'vite.config.js', text: 'export default { ...shared, test: {} };', expected: { jest: false, vitest: true } },
  { file: 'vitest.workspace.ts', text: "export default ['packages/*'];", expected: { jest: false, vitest: true } },
])('$file with $text', ({ file, text, expected }) => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-run-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, file), text);
  expect(configuredWorkers(root)).toEqual(expected);
});

test('a package.json jest key with an unknown preset counts as set, a React Native preset or an unrelated key does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-run-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ jest: { testEnvironment: 'node' } }));
  expect(configuredWorkers(root).jest).toBe(false);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ jest: { preset: 'react-native' } }));
  expect(configuredWorkers(root).jest).toBe(false);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ jest: { preset: 'ts-jest' } }));
  expect(configuredWorkers(root).jest).toBe(true);
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

test('reads the Vitest version from the nearest node_modules above the package', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-run-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages', 'app');
  mkdirSync(pkg, { recursive: true });
  expect(installedVitestVersion(pkg)).toBeNull();
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ version: '3.1.4' }));
  expect(installedVitestVersion(pkg)).toBe('3.1.4');
  mkdirSync(join(pkg, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(pkg, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ version: '5.0.4' }));
  expect(installedVitestVersion(pkg)).toBe('5.0.4');
});

test('reads the Vitest version of the executable a bare or path vitest runs, and of node_modules for launchers', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-run-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (dir: string, json: object) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  };
  const app = join(root, 'app');
  pkg(join(app, 'node_modules', 'vitest'), { name: 'vitest', version: '5.0.4' });
  mkdirSync(join(app, 'node_modules', '.bin'));
  writeFileSync(join(app, 'node_modules', '.bin', 'vitest'), '');
  const global = join(root, 'global', 'lib', 'node_modules', 'vitest');
  pkg(global, { name: 'vitest', version: '2.1.9' });
  writeFileSync(join(global, 'vitest.mjs'), '');
  mkdirSync(join(root, 'global', 'bin'));
  symlinkSync(join(global, 'vitest.mjs'), join(root, 'global', 'bin', 'vitest'));
  mkdirSync(join(root, 'usr', 'bin'), { recursive: true });
  writeFileSync(join(root, 'usr', 'bin', 'vitest'), '');
  const found = (path: string | null) => () => path;
  expect(vitestVersionFor(['vitest', 'run'], app, found(join(root, 'global', 'bin', 'vitest')))).toBe('2.1.9');
  expect(vitestVersionFor(['vitest', 'run'], app, found(join(app, 'node_modules', '.bin', 'vitest')))).toBe('5.0.4');
  expect(vitestVersionFor(['vitest', 'run'], app, found(null))).toBeNull();
  const wrapper = join(root, 'usr', 'bin', 'vitest');
  expect(vitestVersionFor([wrapper, 'run'], app, found(wrapper))).toBeNull();
  expect(vitestVersionFor(['npx', 'vitest'], app, found(null))).toBe('5.0.4');
  const globalBin = join(root, 'global', 'bin', 'vitest');
  expect(vitestVersionFor(['pnpm', 'exec', globalBin, 'run'], app, found(globalBin))).toBe('2.1.9');
  expect(vitestVersionFor(['npx', wrapper, 'run'], app, found(wrapper))).toBeNull();
  expect(vitestVersionFor(['bunx', './missing/vitest'], app, found(null))).toBeNull();
  expect(vitestVersionFor(['npm', 'run', 'test'], app, found(null))).toBe('5.0.4');
});
