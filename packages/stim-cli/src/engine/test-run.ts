import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

function nearestPackageDir(cwd: string): string | null {
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

const CONFIG_FILE = /^(jest|vitest|vite)\.config\.[cm]?[jt]s$|^jest\.config\.json$/;

/**
 * Whether the Jest or Vitest config beside the nearest package.json, or its `jest` key, sets `maxWorkers`. A text match
 * is enough: the flag and the variable Stim would pass override the config.
 */
export function configuredWorkers(cwd: string): { jest: boolean; vitest: boolean } {
  const found = { jest: false, vitest: false };
  const dir = nearestPackageDir(cwd);
  if (!dir) return found;
  const jestKey = readPackage(dir)?.jest;
  if (jestKey && typeof jestKey === 'object' && 'maxWorkers' in jestKey) found.jest = true;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const name of names) {
    const match = CONFIG_FILE.exec(name);
    if (!match) continue;
    let text = '';
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {}
    if (/maxWorkers|max(Threads|Forks)/.test(text)) found[match[1] === 'jest' ? 'jest' : 'vitest'] = true;
  }
  return found;
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
function runnerAt(argv: readonly string[]): { runner: 'jest' | 'vitest'; index: number } | null {
  for (const launcher of LAUNCHERS) {
    if (!launcher.every((word, index) => runnerName(argv[index] ?? '') === word)) continue;
    const name = runnerName(argv[launcher.length] ?? '');
    if (name === 'jest' || name === 'vitest') return { runner: name, index: launcher.length };
  }
  return null;
}

const JEST_SET = /^(?:--maxWorkers|--max-workers|-w)(?:=.*|\d+)?$|^(?:--runInBand|--run-in-band|-i)$/;
const VITEST_SET = /^(?:--maxWorkers|--max-workers)(?:=.*)?$|^--(?:no-)?file-?[pP]arallelism(?:=.*)?$|^--poolOptions\./;
const PLAIN_JEST = /^jest(?:\s+[\w@%=.:/,+-]+)*$/;
const VITEST_VARIABLES = ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS'] as const;

export interface TestPlan {
  argv: string[];
  env: Record<string, string>;
  /** How the worker count reaches the runner, or why it does not. */
  applied: string | null;
  skipped: string | null;
}

/**
 * How a run of `argv` gets `workers`: Jest reads only its `--maxWorkers` flag, so a direct Jest invocation gets it after
 * the `jest` word, and the project's `test` script gets it through the package manager only when that script is a plain
 * `jest` call. Vitest 4 and later read `VITEST_MAX_WORKERS`, Vitest 2 and 3 `VITEST_MAX_THREADS` and `VITEST_MAX_FORKS`;
 * all three are set unless the caller set one, a worker flag, or `configured` says the project's config sets workers,
 * since each variable overrides both. A count the caller set is never replaced.
 */
export function planTestRun({
  argv,
  workers,
  env,
  script,
  manager,
  configured = { jest: false, vitest: false },
}: {
  argv: string[];
  workers: number;
  env: NodeJS.ProcessEnv;
  /** The project's `test` script, when `argv` is the package manager running it. */
  script?: string | null;
  manager?: PackageManager;
  configured?: { jest: boolean; vitest: boolean };
}): TestPlan {
  const words = script ? script.trim().split(/\s+/) : argv;
  const direct = script ? null : runnerAt(argv);
  const mentions = (name: string) => words.some((word) => runnerName(word) === name);
  const vitestSet =
    configured.vitest ||
    VITEST_VARIABLES.some((name) => env[name] !== undefined) ||
    words.some((word) => VITEST_SET.test(word));
  const vitestEnv: Record<string, string> = vitestSet
    ? {}
    : Object.fromEntries(VITEST_VARIABLES.map((name) => [name, String(workers)]));
  const plan = (applied: string | null, skipped: string | null, next = argv): TestPlan => ({
    argv: next,
    env: vitestEnv,
    applied,
    skipped,
  });
  const flag = `--maxWorkers=${workers}`;
  if (direct?.runner === 'jest' || (script && mentions('jest'))) {
    if (configured.jest) return plan(null, "the project's Jest config sets maxWorkers");
    if (words.some((word) => JEST_SET.test(word))) return plan(null, 'the command already sets Jest workers');
    if (direct) {
      const index = direct.index + 1;
      return plan(flag, null, [...argv.slice(0, index), flag, ...argv.slice(index)]);
    }
    if (!script || !PLAIN_JEST.test(script.trim()))
      return plan(null, 'the test script is not a plain jest command, so Stim cannot pass it --maxWorkers');
    return plan(flag, null, [...argv, ...(manager === 'npm' ? ['--', flag] : [flag])]);
  }
  if (direct?.runner === 'vitest' || mentions('vitest')) {
    if (configured.vitest) return plan(null, "the project's Vitest config sets its workers");
    return vitestSet
      ? plan(null, 'the command already sets Vitest workers')
      : plan(`VITEST_MAX_WORKERS=${workers}`, null);
  }
  return plan(
    null,
    `Stim recognises no Jest or Vitest in it${vitestSet ? '' : `; VITEST_MAX_WORKERS=${workers} is set for a Vitest it starts`}`,
  );
}
