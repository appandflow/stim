import {
  nearestPackageDir,
  packageManagerFor,
  scriptRunner,
  testScriptFor,
  type PackageManager,
  type Runner,
} from './test-run.ts';

/** Every test kind, in the order plain `stim test` runs them. */
export const TEST_KINDS = [
  'js',
  'rust',
  'android',
  'macos',
  'web',
  'ios',
  'android-device',
  'e2e-ios',
  'e2e-android',
] as const;
export type TestKind = (typeof TEST_KINDS)[number];

/** The kinds this version of Stim can run. */
export const AVAILABLE_KINDS: readonly TestKind[] = ['js'];

const isKind = (word: string): word is TestKind => TEST_KINDS.some((kind) => kind === word);

/**
 * The kinds `words` name, in the order given and without repeats, with `e2e` standing for every `e2e-*` kind; or the
 * first word that names no kind.
 */
export function namedKinds(words: readonly string[]): { kinds: TestKind[] } | { unknown: string } {
  const kinds: TestKind[] = [];
  for (const word of words) {
    const named: TestKind[] | null = word === 'e2e' ? ['e2e-ios', 'e2e-android'] : isKind(word) ? [word] : null;
    if (!named) return { unknown: word };
    for (const kind of named) if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { kinds };
}

const SCRIPT_RUNNERS: readonly [string, readonly TestKind[]][] = [
  ['cargo', ['rust']],
  ['gradlew', ['android', 'android-device']],
  ['playwright', ['web']],
  ['cypress', ['web']],
  ['xcodebuild', ['ios']],
  ['detox', ['e2e-ios', 'e2e-android']],
  ['maestro', ['e2e-ios', 'e2e-android']],
];

/** The other kinds whose runner the `test` script names as a word, each with that runner, in run order. */
export function scriptRunsKinds(script: string): Map<TestKind, string> {
  const found = new Map<TestKind, string>();
  for (const [runner, kinds] of SCRIPT_RUNNERS) {
    if (!new RegExp(`(?:^|[\\s;&|()'"/=])${runner}(?=$|[\\s;&|()'"])`).test(script)) continue;
    for (const kind of kinds) if (!found.has(kind)) found.set(kind, runner);
  }
  return new Map(TEST_KINDS.flatMap((kind) => (found.has(kind) ? [[kind, found.get(kind) ?? '']] : [])));
}

export interface DetectedKind {
  kind: TestKind;
  /** The command, before Stim adds a worker count. */
  argv: string[];
  cwd: string;
  manager: PackageManager;
  script: string;
  /** The runner Stim can size, or null when it runs the command unchanged. */
  runner: Runner | null;
}

/**
 * The kinds the project at `cwd` has, in run order: `js` when the nearest package.json has a `test` script, run through
 * the package manager whose lockfile is nearest.
 */
export function detectKinds(cwd: string): DetectedKind[] {
  const script = testScriptFor(cwd);
  const dir = nearestPackageDir(cwd);
  if (script === null || dir === null) return [];
  const manager = packageManagerFor(cwd);
  return [{ kind: 'js', argv: [manager, 'run', 'test'], cwd: dir, manager, script, runner: scriptRunner(script) }];
}

/**
 * Splits the detected kinds into those plain `stim test` runs and those it skips because the `js` kind's `test` script
 * already runs their runner, so that they do not run twice.
 */
export function skipScriptKinds(kinds: readonly DetectedKind[]): {
  run: DetectedKind[];
  skipped: { kind: TestKind; reason: string }[];
} {
  const script = kinds.find((each) => each.kind === 'js')?.script;
  const covered = script === undefined ? new Map<TestKind, string>() : scriptRunsKinds(script);
  return {
    run: kinds.filter((each) => !covered.has(each.kind)),
    skipped: kinds.flatMap((each) => {
      const runner = covered.get(each.kind);
      return runner === undefined ? [] : [{ kind: each.kind, reason: `the test script runs ${runner}` }];
    }),
  };
}
