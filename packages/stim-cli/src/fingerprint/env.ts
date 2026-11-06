import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { byCodeUnit, canonicalJson, sha256, type Input, type Platform } from './key.ts';

type Env = NodeJS.ProcessEnv;

/**
 * Diagnostic and terminal names, and the CI vendor names `supports-color` checks after `CI` (React Native's CLI
 * config loads it), which is pinned. They never become rows and are removed from the evaluator env.
 */
const DENIED =
  /^(?:DEBUG.*|NODE_DEBUG|NODE_V8_COVERAGE|NO_COLOR|NODE_DISABLE_COLORS|COLORTERM|TERM.*|TRACE_DEPRECATION|NO_DEPRECATION|__IS_WSL_TEST__|TEST_GRACEFUL_FS_GLOBAL_PATCH|COLUMNS|LINES|STIM_.*|TRAVIS|CIRCLECI|APPVEYOR|GITLAB_CI|GITHUB_ACTIONS|BUILDKITE|DRONE|CI_NAME|TEAMCITY_VERSION)$/;
const VOLATILE = /^(?:PWD|OLDPWD|SHLVL|_|TMPDIR|SSH_.*|__CF.*)$/;
const PINS = { CI: '1', FORCE_COLOR: '0', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
const PINNED = new Set([...Object.keys(PINS), 'PWD', 'EXPO_NO_TELEMETRY']);
/** Toolchain and machine locations: out of the key and never sent to a build worker. */
const MACHINE_LOCAL = new Set([
  'PATH',
  'HOME',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_NDK_HOME',
  'NODE_BINARY',
  'DEVELOPER_DIR',
]);
const BUILD_DENIED = new Set(['USE_CCACHE', 'APP_PATH', 'RCT_SKIP_CACHES']);
const SCANNED = /(?:\.podspec|\.rb|\.gradle|\.gradle\.kts|^Podfile|^CMakeLists\.txt)$/;
const PRUNED = new Set(['node_modules', 'Pods', '.gradle', '.git']);
const BUILD_SIBLINGS = /^(?:Podfile|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|.*\.xcodeproj)$/;
const NAME = '([A-Za-z_][A-Za-z0-9_]*)';
const RUBY_READ = String.raw`ENV(?:\[\s*|\.(?:fetch|key\?|include\?|has_key\?)\(\s*)`;
const LITERAL_READS = [
  new RegExp(String.raw`${RUBY_READ}(['"])${NAME}\1`, 'g'),
  new RegExp(String.raw`(?:System\.getenv|environmentVariable)\(\s*(['"])${NAME}\1`, 'g'),
  new RegExp(String.raw`\$ENV\{()${NAME}\}`, 'g'),
];
const CONSTANT_READ = new RegExp(String.raw`${RUBY_READ}()([A-Z][A-Z0-9_]*)\s*[\],)]`, 'g');
const DYNAMIC_READ = new RegExp(String.raw`${RUBY_READ}[a-z_]|(?:getenv|environmentVariable)\(\s*[A-Za-z_]`);
const NAME_LITERAL = /['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g;
const RUBY_CONSTANT = new RegExp(String.raw`^\s*([A-Z][A-Z0-9_]*)\s*=\s*['"]${NAME}['"]`, 'gm');

export const isDenied = (name: string): boolean => DENIED.test(name);
const keyable = (name: string) => !isDenied(name) && !MACHINE_LOCAL.has(name);
const defined = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/**
 * The env every evaluator child and `expo prebuild` run under: the requester's, without Stim's own and diagnostic
 * names, with the prebuild pins and a fixed locale, timezone and `PWD`, so terminals, CI and agents agree.
 */
export function evaluatorEnv(requester: Env, root: string, platform: Platform): Record<string, string> {
  const env = defined(requester);
  for (const name of Object.keys(env))
    if (isDenied(name) || (platform === 'ios' && name === 'ANDROID_HOME')) delete env[name];
  return { EXPO_NO_TELEMETRY: '1', ...env, ...PINS, PWD: root };
}

/** The env `expo-constants` evaluates the embedded config in: the native build's own, minus the deny list. */
export function embedEnv(requester: Env, platform: Platform): Record<string, string> {
  const env = defined(requester);
  for (const name of Object.keys(env)) if (isDenied(name)) delete env[name];
  return platform === 'ios' ? { ...env, FORCE_COLOR: '0' } : env;
}

/**
 * Rows for env names a part read, valued from the env the part ran under. Pinned names are rows only when the part
 * ran without the pins.
 */
export function envRows(prefix: string, names: Iterable<string>, env: Env, pinned: boolean): Input[] {
  return [...new Set(names)]
    .filter((name) => keyable(name) && !(pinned && PINNED.has(name)))
    .map((name) => ({ name: `${prefix}${name}`, kind: 'env', hash: sha256(canonicalJson(env[name] ?? null)) }));
}

/** `env:*`: what project code that enumerates `process.env` can see. */
export function enumerationRow(env: Env): Input {
  const entries = Object.entries(defined(env))
    .filter(([name]) => keyable(name) && !VOLATILE.test(name) && !PINNED.has(name))
    .toSorted(([a], [b]) => byCodeUnit(a, b));
  return { name: 'env:*', kind: 'env', hash: sha256(canonicalJson(entries)) };
}

/**
 * The base env of every step of an offloaded build: the worker's own, with every name the client keyed replaced by
 * the client's value or removed when the client had none.
 */
export function jobEnv(base: Env, client: { set: Record<string, string>; absent: readonly string[] }): Env {
  const env = defined(base);
  for (const name of Object.keys(env))
    if (isDenied(name) || name in client.set || client.absent.includes(name)) delete env[name];
  return { ...env, ...client.set };
}

/** Podfile, podspec, Ruby, Gradle and CMake files under `dir`, without installed or generated subtrees. */
export function buildScripts(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const generated = entries.some((entry) => BUILD_SIBLINGS.test(entry.name));
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return PRUNED.has(entry.name) || (generated && entry.name === 'build') ? [] : buildScripts(path);
    return entry.isFile() && SCANNED.test(entry.name) ? [path] : [];
  });
}

/**
 * Env names a build script reads by a literal name, in the forms of Ruby, Gradle, Kotlin and CMake, or through a Ruby
 * constant the same file assigns. A file that also reads a name held in a variable contributes every quoted
 * `UPPER_SNAKE` literal it contains, since any of them can reach that read.
 */
function scriptEnvNames(text: string): string[] {
  const constants = new Map([...text.matchAll(RUBY_CONSTANT)].map((match) => [match[1], match[2]]));
  const viaConstants = [...text.matchAll(CONSTANT_READ)].map((match) => constants.get(match[2] ?? ''));
  const dynamic = DYNAMIC_READ.test(text) || viaConstants.includes(undefined);
  return [
    ...LITERAL_READS.flatMap((form) => [...text.matchAll(form)].map((match) => match[2] ?? '')),
    ...viaConstants.filter((name) => name !== undefined),
    ...(dynamic ? [...text.matchAll(NAME_LITERAL)].map((match) => match[1] ?? '') : []),
  ];
}

/** The Podfile and Gradle scripts of the template `expo prebuild` generates the native directories from. */
export function templateScripts(tgz: string): string[] {
  const tar = gunzipSync(readFileSync(tgz));
  const texts: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size =
      Number.parseInt(
        tar
          .toString('utf8', offset + 124, offset + 136)
          .replace(/\0.*$/s, '')
          .trim(),
        8,
      ) || 0;
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (SCANNED.test(base)) texts.push(tar.toString('utf8', offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return texts;
}

/**
 * Row 24: every env name the native build scripts read, valued from the env the native build runs under, plus every
 * `ORG_GRADLE_PROJECT_*` on Android, which Gradle reads as project properties. An absolute path value is keyed in
 * its `pathForm`, and returned so its file or tree can be hashed too.
 */
export function buildEnvRows(
  texts: readonly string[],
  env: Env,
  platform: Platform,
  pathForm: (path: string) => string,
): { rows: Input[]; paths: string[] } {
  const names = new Set(texts.flatMap(scriptEnvNames).filter((name) => keyable(name) && !BUILD_DENIED.has(name)));
  if (platform === 'android')
    for (const name of Object.keys(env)) if (name.startsWith('ORG_GRADLE_PROJECT_')) names.add(name);
  const paths: string[] = [];
  const valued: Env = {};
  for (const name of names) {
    const value = env[name];
    const path = typeof value === 'string' && isAbsolute(value);
    if (path) paths.push(value);
    valued[name] = path ? pathForm(value) : value;
  }
  return { rows: envRows('env:', names, valued, false), paths };
}
