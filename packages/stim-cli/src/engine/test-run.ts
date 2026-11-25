import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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

/** The version of the `vitest` package in the nearest node_modules at or above `dir`, or null when none is readable. */
export function installedVitestVersion(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, 'node_modules', 'vitest', 'package.json');
    if (existsSync(file)) {
      const version = readPackage(dirname(file))?.version;
      return typeof version === 'string' ? version : null;
    }
    if (dirname(at) === at) return null;
  }
}

/**
 * The version of the Vitest that `argv` runs. An argv that starts with `vitest` itself, by name or path, or names a
 * path to it behind a launcher, runs the file `find` resolves (PATH or that path): the package that file belongs to, or
 * the `vitest` package beside a `node_modules/.bin` shim. A launcher with the bare name, or a package-manager script,
 * runs the nearest node_modules install. Null when the executable's package cannot be established.
 */
export function vitestVersionFor(
  argv: readonly string[],
  dir: string,
  find: (file: string) => string | null,
): string | null {
  const index = runnerAt(argv, [])?.index;
  const file = argv[index ?? 0] ?? '';
  if (index === undefined || runnerName(file) !== 'vitest' || (index > 0 && file === 'vitest'))
    return installedVitestVersion(dir);
  const found = find(file);
  if (!found) return null;
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return null;
  }
  const bin = dirname(real);
  if (basename(bin) === '.bin' && basename(dirname(bin)) === 'node_modules') {
    const version = readPackage(join(dirname(bin), 'vitest'))?.version;
    return typeof version === 'string' ? version : null;
  }
  for (let at = bin; ; at = dirname(at)) {
    const pkg = readPackage(at);
    if (pkg) return pkg.name === 'vitest' && typeof pkg.version === 'string' ? pkg.version : null;
    if (dirname(at) === at) return null;
  }
}

/**
 * The flags that give Vitest `version` `workers`, or null when Stim cannot tell. Vitest 1.3 to 3.2.3 default
 * `minWorkers` to the cores but one and refuse a lower `--maxWorkers` (vitest-dev/vitest#7974, fixed in 3.2.4), so they
 * also get `--minWorkers=1`; Vitest 4 removed `minWorkers`, and 5 refuses the flag as an unknown option.
 */
function vitestWorkerFlags(version: string | null, workers: number): string[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return null;
  const [major = 0, minor = 0, patch = 0] = match.slice(1).map(Number);
  const atLeast = (a: number, b: number, c: number) => (major !== a ? major > a : minor !== b ? minor > b : patch >= c);
  if (atLeast(3, 2, 4)) return [`--maxWorkers=${workers}`];
  if (atLeast(1, 3, 0)) return [`--maxWorkers=${workers}`, '--minWorkers=1'];
  return null;
}

/**
 * Workers for one test run: `fixed` (`concurrency.testWorkers`) when above 0, unchanged by the load; else the cores but
 * one, shared between the `concurrency.maxTests` slots, and scaled down by `cores / load1` when the 1-minute load is
 * already past the core count, never under 1.
 */
export function testWorkerCount({
  cores,
  slots,
  load1,
  fixed = 0,
}: {
  cores: number;
  slots: number;
  load1: number;
  fixed?: number;
}): number {
  // @ref LLP 0020#a-fixed-worker-count -- a set count skips the load reduction
  if (fixed > 0) return fixed;
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

const LAUNCHERS: readonly (readonly string[])[] = [[], ['npx'], ['bunx'], ['pnpm'], ['pnpm', 'exec'], ['yarn']];

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
    // Yarn 1.22 forwards only the words after a `--` to the binary, and drops every option after `yarn exec <bin>`.
    if (launcher[0] === 'yarn' && argv.includes('--')) return null;
    return { runner: name, index: launcher.length };
  }
  return null;
}

const JEST_SET =
  /^(?:--maxWorkers|--max-workers)(?:=.*)?$|^(?:--runInBand|--run-in-band|--config|--preset|--projects)(?:=.*)?$|^-[A-Za-z]*[ciw]/;
const VITEST_SET =
  /^(?:--(?:max|min)-?[wW]orkers|--config|--root|--dir|--project|--workspace|--pool)(?:=.*)?$|^--(?:no-)?file-?[pP]arallelism(?:=.*)?$|^--poolOptions\.|^-[A-Za-z]*[cr]/;
const NODE_SET = /^--(?:test-concurrency|experimental-config-file|experimental-default-config-file)(?:=.*)?$/;
const PLAIN_SCRIPT = /^(jest|vitest)(?:[ \t]+(?!--(?:[ \t]|$))[\w@%=.:/,+-]+)*$/;
const NODE_SCRIPT = /^node(?:[ \t]+(?!--(?:[ \t]|$))[\w@%=.:/,+-]+)*$/;
const NODE_VALUE_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-C',
  '--conditions',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-shard',
  '--test-timeout',
]);

/**
 * Where `--test` sits in a `node` argv, when it is one of node's own options: before the first word that is neither an
 * option nor the value of one, which starts the script or the test file patterns. `whole` also requires that no such
 * word follows, so that options appended to the argv still reach node and not the script.
 */
function nodeTestAt(words: readonly string[], whole: boolean): number | null {
  if (runnerName(words[0] ?? '') !== 'node') return null;
  let at: number | null = null;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? '';
    if (word === '--test') at ??= index;
    else if (NODE_VALUE_OPTIONS.has(word)) index++;
    else if (word === '--' || !word.startsWith('-')) return whole ? null : at;
  }
  return at;
}

export interface TestPlan {
  argv: string[];
  /** How the worker count reaches the runner, or why it does not. */
  applied: string | null;
  skipped: string | null;
}

export type Runner = 'jest' | 'vitest' | 'node';

/** The runner the project's `test` script runs, when it is a plain command Stim can pass a worker count to. */
export function scriptRunner(script: string): Runner | null {
  const plain = PLAIN_SCRIPT.exec(script.trim());
  if (plain?.[1] === 'jest' || plain?.[1] === 'vitest') return plain[1];
  return NODE_SCRIPT.test(script.trim()) && nodeTestAt(script.trim().split(/\s+/), true) !== null ? 'node' : null;
}

/**
 * How a run of `argv` gets `workers`. Jest and Vitest take a `--maxWorkers` flag, and node's test runner
 * `--test-concurrency`, which Stim passes only where it can see the whole command: the runner run directly, where the
 * flag goes before any `--` (for node, right after `--test`, since node reads no option after the first test file), or
 * the project's `test` script through the package manager when that script is a plain `jest`, `vitest` or `node --test`
 * command, with `extra` arguments after the flag. Vitest applies its `fileParallelism: false` after the flag, so a
 * serial config stays serial. Nothing is passed when the command, `extra`, `NODE_OPTIONS` or a config Stim can see sets
 * workers or names another config, and any other command runs unchanged.
 */
export function planTestRun({
  argv,
  workers,
  script,
  manager,
  extra = [],
  configured = { jest: false, vitest: false },
  scripts = [],
  vitestVersion = null,
  nodeOptions = '',
}: {
  argv: string[];
  workers: number;
  /** The project's `test` script, when `argv` is the package manager running it. */
  script?: string | null;
  manager?: PackageManager;
  /** Arguments for the `test` script, passed after the worker flag. */
  extra?: readonly string[];
  configured?: { jest: boolean; vitest: boolean };
  /** The package's script names: `pnpm jest` and `yarn jest` run a script of that name before the binary. */
  scripts?: readonly string[];
  /** The installed Vitest version, which decides its worker flags. */
  vitestVersion?: string | null;
  /** The run's `NODE_OPTIONS`, which node reads before its command line. */
  nodeOptions?: string;
}): TestPlan {
  const withScript = (flags: string[]) =>
    flags.length + extra.length && manager === 'npm'
      ? [...argv, '--', ...flags, ...extra]
      : [...argv, ...flags, ...extra];
  const unchanged = (skipped: string): TestPlan => ({ argv: withScript([]), applied: null, skipped });
  const direct = script ? null : runnerAt(argv, scripts);
  const nodeAt = script ? null : nodeTestAt(argv, false);
  const runner: Runner | null = script ? scriptRunner(script) : (direct?.runner ?? (nodeAt === null ? null : 'node'));
  if (!runner)
    return unchanged(
      script
        ? 'the test script is not a plain jest, vitest or node --test command, so Stim cannot pass it a worker count'
        : 'Stim recognises no direct Jest, Vitest or node --test run in it',
    );
  const name = runner === 'jest' ? 'Jest' : runner === 'vitest' ? 'Vitest' : 'node --test';
  if (runner !== 'node' && configured[runner])
    return unchanged(`a ${name} config here may set its workers or run serially`);
  const words = [...(script ? script.trim().split(/\s+/) : argv.slice((direct?.index ?? 0) + 1)), ...extra];
  if (runner === 'node') words.push(...nodeOptions.split(/\s+/));
  if (words.some((word) => (runner === 'jest' ? JEST_SET : runner === 'vitest' ? VITEST_SET : NODE_SET).test(word)))
    return unchanged(`the command already sets ${name} workers or names another config`);
  const flags =
    runner === 'jest'
      ? [`--maxWorkers=${workers}`]
      : runner === 'node'
        ? [`--test-concurrency=${workers}`]
        : vitestWorkerFlags(vitestVersion, workers);
  if (!flags)
    return unchanged(
      vitestVersion
        ? `Stim does not know the worker flags of Vitest ${vitestVersion}`
        : 'Stim cannot read the installed Vitest version, which decides its worker flags',
    );
  const applied = flags.join(' ');
  if (script) return { argv: withScript(flags), applied, skipped: null };
  const end = direct ? argv.indexOf('--', direct.index + 1) : -1;
  const at = direct ? (end < 0 ? argv.length : end) : (nodeAt ?? 0) + 1;
  return { argv: [...argv.slice(0, at), ...flags, ...argv.slice(at)], applied, skipped: null };
}
