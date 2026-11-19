import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join } from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/** The package manager whose lockfile is nearest to `cwd`, walking up; npm when none is found. */
export function packageManagerFor(cwd: string): PackageManager {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = LOCKFILES.find(([file]) => existsSync(join(dir, file)));
    if (found) return found[1];
    if (dirname(dir) === dir) return 'npm';
  }
}

/** The directory of the package.json nearest to `cwd`, walking up. */
export function nearestPackageDir(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function readPackage(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...parsed } : null;
  } catch {
    return null;
  }
}

/** The `test` script of the package.json nearest to `cwd`, walking up, as the package managers find it. */
export function testScriptFor(cwd: string): string | null {
  const dir = nearestPackageDir(cwd);
  const scripts = dir ? readPackage(dir)?.scripts : null;
  const script = scripts && typeof scripts === 'object' && 'test' in scripts ? scripts.test : null;
  return typeof script === 'string' && script.trim() ? script : null;
}

const JEST_CONFIG = /^jest\.config\.(?:[cm]?[jt]s|json)$/;
const VITEST_CONFIG = /^(?:vitest|vite)\.(?:config|workspace)\.(?:[cm]?[jt]s|json)$/;
const JEST_CONFIG_SETS = /maxWorkers|minWorkers|runInBand|projects/;
const VITEST_CONFIG_SETS =
  /(?:max|min)(?:Workers|Threads|Forks)|fileParallelism|singleFork|singleThread|poolOptions|\bpool\b|projects|workspace|mergeConfig|\bextends\b/;
const KNOWN_PRESET =
  /["']?\bpreset["']?\s*:\s*["'](?:react-native|@react-native\/jest-preset|jest-expo(?:\/(?:ios|android|web|node))?)["']/g;
const MODULE =
  /\bfrom\s*['"]([^'"]*)['"]|\bimport\s*['"]([^'"]*)['"]|\b(?:require|import)\s*\(\s*(?:['"]([^'"]*)['"])?/g;
const NEUTRAL_MODULES = new Set(['vite', 'vitest', 'vitest/config']);
const TYPE_MODULES = new Set(['jest', '@jest/types']);
const ARRAY = /\[[^[\]]*\]/g;

/**
 * Whether config text may take its settings from somewhere Stim does not read: a Jest preset other than the React
 * Native and Expo ones, a module other than Node's own, Vite's and Vitest's (Jest's only as types), or an object
 * spread.
 */
function borrowsConfig(text: string): boolean {
  if (/\bpreset\b/.test(text.replace(KNOWN_PRESET, ''))) return true;
  for (const match of text.matchAll(MODULE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) return true;
    if (NEUTRAL_MODULES.has(specifier) || builtinModules.includes(specifier.replace(/^node:/, ''))) continue;
    if (TYPE_MODULES.has(specifier) && new RegExp(`\\bimport\\s+type\\b[^;]*?from\\s*['"]${specifier}['"]`).test(text))
      continue;
    return true;
  }
  let flat = text;
  for (let last = ''; last !== flat;) [last, flat] = [flat, flat.replace(ARRAY, '')];
  return /\.\.\.\s*[\w(]/.test(flat);
}

/** The script names of the package.json nearest to `cwd`. */
export function packageScripts(cwd: string): string[] {
  const dir = nearestPackageDir(cwd);
  const scripts = dir ? readPackage(dir)?.scripts : null;
  return scripts && typeof scripts === 'object' ? Object.keys(scripts) : [];
}

/**
 * Whether a Jest or Vitest config Stim can see may set the run's workers itself, so that Stim passes no count: a
 * `jest`, `vitest` or `vite` config in the working directory or a parent up to the nearest package.json, or that
 * package.json's `jest` key, that names a worker, serial-run, pool or project setting, takes settings from elsewhere
 * (see `borrowsConfig`), or cannot be read. A `--maxWorkers` flag would override `maxWorkers`, a lower `--maxWorkers` than a set
 * `minWorkers` crashes Vitest 2 and 3, and serial settings must stay serial.
 */
export function configuredWorkers(cwd: string): { jest: boolean; vitest: boolean } {
  const found = { jest: false, vitest: false };
  const top = nearestPackageDir(cwd);
  const jestKey = top ? readPackage(top)?.jest : undefined;
  const jestText = JSON.stringify(jestKey) ?? '';
  if (jestKey !== undefined && (JEST_CONFIG_SETS.test(jestText) || borrowsConfig(jestText))) found.jest = true;
  for (let dir = cwd; ; dir = dirname(dir)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names) {
      const runner = JEST_CONFIG.test(name) ? 'jest' : VITEST_CONFIG.test(name) ? 'vitest' : null;
      if (!runner) continue;
      let text: string | null = null;
      try {
        text = readFileSync(join(dir, name), 'utf8');
      } catch {}
      const sets = runner === 'jest' ? JEST_CONFIG_SETS : VITEST_CONFIG_SETS;
      if (text === null || name.includes('.workspace.') || sets.test(text) || borrowsConfig(text)) found[runner] = true;
    }
    if (dir === top || dirname(dir) === dir || top === null) return found;
  }
}

/**
 * Workers for one test run: the cores but one, shared between the `concurrency.maxTests` slots, and scaled down by
 * `cores / load1` when the 1-minute load is already past the core count, never under 1.
 */
export function testWorkerCount({ cores, slots, load1 }: { cores: number; slots: number; load1: number }): number {
  const share = Math.max(1, Math.floor((cores - 1) / Math.max(1, slots)));
  return Math.max(1, load1 > cores ? Math.floor((share * cores) / load1) : share);
}

const MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** The package manager an argv uses to run the `test` script: `<pm> test` or `<pm> run test`; `bun test` is Bun's runner. */
export function testScriptRun(argv: readonly string[]): PackageManager | null {
  const manager = MANAGERS.find((name) => name === argv[0]);
  if (!manager) return null;
  if (argv.length === 3 && argv[1] === 'run' && argv[2] === 'test') return manager;
  return argv.length === 2 && argv[1] === 'test' && manager !== 'bun' ? manager : null;
}

const LAUNCHERS: readonly (readonly string[])[] = [
  [],
  ['npx'],
  ['bunx'],
  ['pnpm'],
  ['pnpm', 'exec'],
  ['yarn'],
  ['yarn', 'exec'],
];

const runnerName = (word: string) => basename(word).replace(/\.(cmd|js|mjs|cjs)$/i, '');

/** The index of the `jest` or `vitest` word an argv runs directly, behind at most one of the launchers above. */
function runnerAt(
  argv: readonly string[],
  scripts: readonly string[],
): { runner: 'jest' | 'vitest'; index: number } | null {
  for (const launcher of LAUNCHERS) {
    if (!launcher.every((word, index) => runnerName(argv[index] ?? '') === word)) continue;
    const name = runnerName(argv[launcher.length] ?? '');
    if (name !== 'jest' && name !== 'vitest') continue;
    if (launcher.length === 1 && (launcher[0] === 'pnpm' || launcher[0] === 'yarn') && scripts.includes(name))
      return null;
    return { runner: name, index: launcher.length };
  }
  return null;
}

const JEST_SET =
  /^(?:--maxWorkers|--max-workers|-w)(?:=.*|\d+)?$|^(?:--runInBand|--run-in-band|-i|-c|--config|--preset|--projects)(?:=.*)?$/;
const VITEST_SET =
  /^(?:--(?:max|min)-?[wW]orkers|-c|--config|-r|--root|--dir|--project|--workspace|--pool)(?:=.*)?$|^--(?:no-)?file-?[pP]arallelism(?:=.*)?$|^--poolOptions\./;
const PLAIN_SCRIPT = /^(jest|vitest)(?:[ \t]+(?!--(?:[ \t]|$))[\w@%=.:/,+-]+)*$/;

export interface TestPlan {
  argv: string[];
  /** How the worker count reaches the runner, or why it does not. */
  applied: string | null;
  skipped: string | null;
}

/**
 * How a run of `argv` gets `workers`. Both runners take a `--maxWorkers` flag, which Stim passes only where it can see
 * the whole command: Jest or Vitest run directly, where the flag goes before any `--`, or the project's `test` script
 * through the package manager when that script is a plain `jest` or `vitest` command. Vitest applies its
 * `fileParallelism: false` after the flag, so a serial config stays serial. Nothing is passed when the command or a
 * config Stim can see sets workers or names another config, and any other command runs unchanged.
 */
export function planTestRun({
  argv,
  workers,
  script,
  manager,
  configured = { jest: false, vitest: false },
  scripts = [],
}: {
  argv: string[];
  workers: number;
  /** The project's `test` script, when `argv` is the package manager running it. */
  script?: string | null;
  manager?: PackageManager;
  configured?: { jest: boolean; vitest: boolean };
  /** The package's script names: `pnpm jest` and `yarn jest` run a script of that name before the binary. */
  scripts?: readonly string[];
}): TestPlan {
  const plain = script ? PLAIN_SCRIPT.exec(script.trim()) : null;
  const direct = script ? null : runnerAt(argv, scripts);
  const runner = direct?.runner ?? (plain?.[1] === 'jest' || plain?.[1] === 'vitest' ? plain[1] : null);
  const unchanged = (skipped: string): TestPlan => ({ argv, applied: null, skipped });
  if (!runner)
    return unchanged(
      script
        ? 'the test script is not a plain jest or vitest command, so Stim cannot pass it --maxWorkers'
        : 'Stim recognises no direct Jest or Vitest run in it',
    );
  const name = runner === 'jest' ? 'Jest' : 'Vitest';
  if (configured[runner]) return unchanged(`a ${name} config here may set its workers or run serially`);
  const words = script ? script.trim().split(/\s+/) : argv.slice((direct?.index ?? 0) + 1);
  if (words.some((word) => (runner === 'jest' ? JEST_SET : VITEST_SET).test(word)))
    return unchanged(`the command already sets ${name} workers or names another config`);
  const flag = `--maxWorkers=${workers}`;
  if (direct) {
    const end = argv.indexOf('--', direct.index + 1);
    const at = end < 0 ? argv.length : end;
    return { argv: [...argv.slice(0, at), flag, ...argv.slice(at)], applied: flag, skipped: null };
  }
  return { argv: [...argv, ...(manager === 'npm' ? ['--', flag] : [flag])], applied: flag, skipped: null };
}
