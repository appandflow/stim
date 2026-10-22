import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { normalizeOptionsAsync } from '@expo/fingerprint/build/Options.js';
import { isIgnoredPathWithMatchObjects } from '@expo/fingerprint/build/utils/Path.js';
import { gitAsync } from '../workspace/git.ts';
import { STIM_VERSION } from '../stim-version.ts';
import { expoEnvFiles, fingerprintOptions, type FingerprintTarget } from './build-cache.ts';

const STATIC_SCHEMA = 1;

/** More files than this outside git, or ignored by git, means the static check reads too much to be worth it. */
const UNTRACKED_FILE_CAP = 2000;

const CONFIG_FILES = [
  'app.json',
  'app.config.ts',
  'app.config.js',
  'app.config.mjs',
  'app.config.cjs',
  'app.config.json',
];
const FINGERPRINT_CONFIGS = ['fingerprint.config.js', 'fingerprint.config.cjs'];
const RN_CONFIGS = [
  'react-native.config.js',
  'react-native.config.ts',
  'react-native.config.cjs',
  'react-native.config.mjs',
];
const ROOT_FILES = [
  'package.json',
  ...CONFIG_FILES,
  ...FINGERPRINT_CONFIGS,
  ...RN_CONFIGS,
  '.fingerprintignore',
  '.gitignore',
  'eas.json',
  '.easignore',
  'expo-module.config.json',
];
const ROOT_DIRS = ['patches', 'cng-patches'];
const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'];
const NATIVE_MARKERS = ['expo-module.config.json', ...RN_CONFIGS];
const RISKY_IMPORTS = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'http',
  'https',
  'http2',
  'net',
  'dgram',
  'worker_threads',
  'dotenv',
  'dotenv/config',
  '@dotenvx/dotenvx',
]);
const BUILTINS = new Set(['path', 'os', 'url', 'util', 'crypto', 'module', 'assert', 'events']);
const ASSET =
  /['"`]([^'"`\n]+\.(?:png|jpe?g|webp|gif|svg|ttf|otf|json|plist|xml|mp3|wav|caf|lottie|p8|mobileprovision))['"`]/g;

export type StaticFingerprint =
  | {
      digest: string;
      /** The names of the installed packages it counts as native for the platform, which autolinking would link. */
      nativePackages: string[];
      uncertain: null;
    }
  | { digest: null; nativePackages?: undefined; uncertain: string };

/** An Expo module that declares its platforms is linked only on those; any other native package counts on both. */
function linkedOn(info: PackageInfo, platform: 'ios' | 'android'): boolean {
  if (!info.native) return false;
  if (!Array.isArray(info.platforms)) return true;
  const wanted = platform === 'ios' ? ['ios', 'apple'] : ['android'];
  return (
    info.platforms.some((each) => wanted.includes(String(each))) ||
    (platform === 'ios' ? info.native.includes('*.podspec') : info.native.includes('android/build.gradle'))
  );
}

interface PackageInfo {
  name: string;
  version: string;
  deps: string[];
  native: string[] | null;
  platforms: unknown;
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && key in value ? Reflect.get(value, key) : undefined;

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stringList(value: unknown): string[] {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

class Uncertain extends Error {}

const local = (dir: string) => !dir.split(sep).includes('node_modules');

function resolvePackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The installed packages, keyed by real path: every package reachable from the app's manifest, and every entry of a
 * node_modules directory above the app, which older autolinking scans.
 */
function packageGraph(root: string, manifest: unknown): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  const read = (dir: string): PackageInfo | null => {
    const known = packages.get(dir);
    if (known) return known;
    let json: unknown;
    let entries: string[];
    try {
      json = readJson(join(dir, 'package.json'));
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    const markers = NATIVE_MARKERS.filter((name) => entries.includes(name));
    if (entries.some((name) => name.endsWith('.podspec'))) markers.push('*.podspec');
    if (
      entries.includes('android') &&
      ['build.gradle', 'build.gradle.kts'].some((f) => existsSync(join(dir, 'android', f)))
    )
      markers.push('android/build.gradle');
    if (field(json, 'codegenConfig')) markers.push('codegenConfig');
    let platforms: unknown = null;
    if (markers.includes('expo-module.config.json')) {
      try {
        platforms = field(readJson(join(dir, 'expo-module.config.json')), 'platforms') ?? null;
      } catch {
        platforms = 'unreadable';
      }
    }
    const info: PackageInfo = {
      name: String(field(json, 'name') ?? ''),
      version: String(field(json, 'version') ?? ''),
      deps: ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((key) => stringList(field(json, key))),
      native: markers.length ? markers : null,
      platforms,
    };
    packages.set(dir, info);
    return info;
  };
  const queue: string[] = [];
  const visit = (from: string, names: string[], required: boolean, follow = true) => {
    for (const name of names) {
      const real = resolvePackage(from, name);
      if (!real) {
        if (required) throw new Uncertain(`${name} is not installed`);
        continue;
      }
      if (!packages.has(real) && read(real) && follow) queue.push(real);
    }
  };
  visit(
    root,
    [...stringList(field(manifest, 'dependencies')), ...stringList(field(manifest, 'devDependencies'))],
    true,
  );
  visit(root, stringList(field(manifest, 'optionalDependencies')), false);
  const hoisted: [string, string[]][] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    const modules = join(dir, 'node_modules');
    let names: string[] = [];
    try {
      names = readdirSync(modules).flatMap((name) => {
        if (name.startsWith('.')) return [];
        if (!name.startsWith('@')) return [name];
        try {
          return readdirSync(join(modules, name)).map((scoped) => `${name}/${scoped}`);
        } catch {
          return [];
        }
      });
    } catch {}
    hoisted.push([dir, names]);
    if (dirname(dir) === dir) break;
  }
  while (queue.length) {
    const dir = queue.shift();
    const info = dir === undefined ? undefined : packages.get(dir);
    if (dir !== undefined && info) visit(dir, info.deps, false);
  }
  for (const [dir, names] of hoisted) visit(dir, names, false, false);
  return packages;
}

interface ConfigScan {
  files: Set<string>;
  dirs: Set<string>;
  packages: Set<string>;
  env: Set<string>;
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const path of [
    base,
    ...['.ts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.js'].map((e) => base + e),
  ]) {
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path;
  }
  return null;
}

type ScanMode = 'evaluated' | 'plugin';

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** A string a config names relative to itself: a module it loads, a file it reads at prebuild, or a directory. */
function addNamedPath(file: string, spec: string, scan: ConfigScan, root: string): void {
  const found = resolveRelative(file, spec);
  if (found && /\.[cm]?[jt]sx?$/.test(found)) scanConfigSource(found, scan, 'plugin', root);
  else if (found) scan.files.add(found);
  else if (isDirectory(resolve(dirname(file), spec))) scan.dirs.add(resolve(dirname(file), spec));
}

/** Every `process.env` that is not followed by a literal name: the config passes the environment on as a value. */
const ENV_VALUE = /process\.env\b(?!\s*(?:\??\.\s*[A-Za-z_$]|\[\s*['"]))/;

/**
 * What a config module evaluates, found by reading its source: the local modules, assets and directories it names,
 * the packages it imports and the environment variables it reads. Anything the scan cannot follow throws `Uncertain`.
 * A local plugin named by a path string also runs while the config is evaluated, but its file access normally sits in
 * mods that run at prebuild: its file access counts only when it calls no `with...` mod helper, and its process and
 * network access always counts.
 */
function scanConfigSource(file: string, scan: ConfigScan, mode: ScanMode, root: string): void {
  if (scan.files.has(file)) return;
  scan.files.add(file);
  if (file.endsWith('.json')) {
    scanJsonConfig(file, scan, root);
    return;
  }
  const source = readFileSync(file, 'utf8');
  const where = relative(root, file);
  const uncertain = (reason: string): never => {
    throw new Uncertain(`${reason} in ${where}`);
  };
  const usesMods = /\bwith[A-Z]\w*\s*\(/.test(source);
  const fileAccess = mode === 'evaluated' || !usesMods;
  if (/\brequire\s*\(\s*[^'"\s)]/.test(source) || /\bimport\s*\(\s*[^'"\s)]/.test(source))
    uncertain('a dynamic require or import');
  if (ENV_VALUE.test(source)) uncertain('process.env read without a literal name');
  if (/\b(execSync|execFileSync|spawnSync|exec|execFile|spawn|fetch)\s*\(/.test(source))
    uncertain('process or network access');
  if (
    fileAccess &&
    /\b(readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream)\s*\(/.test(source)
  )
    uncertain('file access');
  if (/[`]\s*\.{1,2}\/[^`]*\$\{/.test(source) || /\$\{[^}]*\}[^`]*\.(?:png|jpe?g|webp|json|plist)`/.test(source))
    uncertain('an asset path built at evaluation');
  for (const match of source.matchAll(/process\.env\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) scan.env.add(String(match[1]));
  for (const match of source.matchAll(/process\.env\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) scan.env.add(String(match[1]));
  const imports = new Set<string>();
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ])
    for (const match of source.matchAll(pattern)) imports.add(String(match[1]));
  for (const spec of imports) {
    const bare = spec.replace(/^node:/, '');
    if (RISKY_IMPORTS.has(bare) || bare.startsWith('dotenv')) {
      const fsOnly = bare === 'fs' || bare === 'fs/promises';
      if (!fsOnly || fileAccess) uncertain(`an import of ${spec}`);
    } else if (spec.startsWith('.')) {
      const found = resolveRelative(file, spec);
      if (!found) throw new Uncertain(`an import of ${spec} that does not resolve in ${where}`);
      scanConfigSource(found, scan, mode, root);
    } else if (!spec.startsWith('node:') && !BUILTINS.has(bare)) {
      scan.packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec));
    }
  }
  for (const match of source.matchAll(/['"](\.{1,2}\/[^'"\n]+)['"]/g)) {
    const spec = String(match[1]);
    if (!imports.has(spec)) addNamedPath(file, spec, scan, root);
  }
  for (const match of source.matchAll(/['"]((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*)['"]/g)) {
    const spec = String(match[1]);
    scan.packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec));
  }
  for (const match of source.matchAll(ASSET)) {
    const path = resolve(dirname(file), String(match[1]));
    if (isFile(path)) scan.files.add(path);
  }
}

/**
 * The local files a static config names: every string value that is a path to a file or, written relative, to a
 * directory, such as an icon, a splash image, a google services file, a fonts directory or a local plugin, and the
 * packages its plugins name.
 */
function scanJsonConfig(file: string, scan: ConfigScan, root: string): void {
  let json: unknown;
  try {
    json = readJson(file);
  } catch {
    throw new Uncertain(`${relative(root, file)} cannot be parsed`);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    else if (typeof value === 'string' && value && value.length < 512 && !value.includes('\n')) {
      const plain = resolve(dirname(file), value);
      if (value.startsWith('.')) addNamedPath(file, value, scan, root);
      else if (isFile(plain)) scan.files.add(plain);
      else if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/.test(value))
        scan.packages.add(
          value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : (value.split('/')[0] ?? value),
        );
    }
  };
  visit(json);
}

function lockfileDigest(root: string, top: string): unknown {
  for (let dir = root; ; dir = dirname(dir)) {
    const name = LOCKFILES.find((file) => existsSync(join(dir, file)));
    if (name) {
      const bytes = readFileSync(join(dir, name));
      if (name.endsWith('b')) return [name, sha256(bytes)];
      const lines = bytes
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .toSorted();
      return [relative(root, join(dir, name)), sha256(lines.join('\n'))];
    }
    if (dir === top || dirname(dir) === dir) return null;
  }
}

const toPosix = (path: string) => path.split(sep).join('/');

/** A variable's value, and the file it names when it names one: a config can take a file path from the environment. */
function envValueDigest(root: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const named = value && value.length < 1024 ? resolve(root, value) : null;
  const file = named && statSync(named, { throwIfNoEntry: false })?.isFile() ? contentId(named) : null;
  return sha256(file ? `${value}\0${file}` : value);
}

function contentId(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return '-';
  if (stat.isSymbolicLink()) return blobId(Buffer.from(readlinkSync(path)));
  return stat.isFile() ? blobId(readFileSync(path)) : '-';
}

/**
 * A digest of the inputs @expo/fingerprint hashes for one platform, read without evaluating the app config or running
 * autolinking: git blob ids of the tracked native inputs, content hashes of the untracked, modified and ignored ones,
 * each installed package's version and native markers, the lockfile, and the config's sources and the environment
 * variables they read. Equal digests mean equal fingerprints only as far as this model of the inputs reaches; it
 * reports `uncertain` for whatever it cannot follow, which then takes the full fingerprint.
 */
export async function staticFingerprint(
  projectRoot: string,
  target: FingerprintTarget & { platform: 'ios' | 'android' },
  { env, signal }: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<StaticFingerprint> {
  try {
    return { ...(await computeDigest(realpathSync(projectRoot), target, env, signal)), uncertain: null };
  } catch (error) {
    if (error instanceof Uncertain) return { digest: null, uncertain: error.message };
    throw error;
  }
}

async function computeDigest(
  root: string,
  target: FingerprintTarget & { platform: 'ios' | 'android' },
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<{ digest: string; nativePackages: string[] }> {
  if (existsSync(join(root, '.pnp.cjs'))) throw new Uncertain('Yarn Plug-n-Play installs have no node_modules to read');
  const normalized = await normalizeOptionsAsync(root, await fingerprintOptions(root, target));
  if (typeof normalized.fileHookTransform === 'function')
    throw new Uncertain('fingerprint.config.js sets fileHookTransform');
  if (normalized.nativeModuleSourceType !== 'package' || normalized.configPluginSourceType !== 'package')
    throw new Uncertain('the fingerprint preset hashes package files');
  let top: string;
  try {
    top = realpathSync(await gitAsync(root, ['rev-parse', '--show-toplevel'], { signal }));
  } catch {
    throw new Uncertain('the project is not in a git work tree');
  }
  let manifest: unknown;
  try {
    manifest = readJson(join(root, 'package.json'));
  } catch {
    throw new Uncertain('package.json cannot be read');
  }

  const packages = packageGraph(root, manifest);
  const scan: ConfigScan = { files: new Set(), dirs: new Set(), packages: new Set(), env: new Set(['EXPO_NO_DOTENV']) };
  for (const name of [...CONFIG_FILES, ...FINGERPRINT_CONFIGS, ...RN_CONFIGS]) {
    const path = join(root, name);
    if (existsSync(path)) scanConfigSource(path, scan, 'evaluated', root);
  }

  const specs = new Set<string>([...ROOT_FILES, ...ROOT_DIRS]);
  const useCNG = normalized.useCNGForPlatforms ?? {};
  if (!field(useCNG, target.platform)) specs.add(target.platform);
  const autolinking = field(field(manifest, 'expo'), 'autolinking');
  specs.add('modules');
  for (const options of [autolinking, field(autolinking, 'ios'), field(autolinking, 'android')]) {
    const nativeModulesDir = field(options, 'nativeModulesDir');
    if (typeof nativeModulesDir === 'string') specs.add(nativeModulesDir);
    const searchPaths = field(options, 'searchPaths');
    if (Array.isArray(searchPaths)) for (const path of searchPaths) if (typeof path === 'string') specs.add(path);
  }
  const extraContents: unknown[] = [];
  for (const source of normalized.extraSources ?? []) {
    if (source.type === 'contents') extraContents.push([source.id, source.contents]);
    else specs.add(source.filePath);
  }
  for (const [dir, info] of packages) if (local(dir) && info.native) specs.add(relative(root, dir));
  for (const name of scan.packages) {
    for (const [dir, info] of packages) if (info.name === name && local(dir)) specs.add(relative(root, dir));
  }

  const insideRepo = (spec: string) => {
    const fromTop = relative(top, resolve(root, spec));
    return !isAbsolute(fromTop) && fromTop !== '..' && !fromTop.startsWith(`..${sep}`);
  };
  const gitSpecs = [...specs].filter(insideRepo).map(toPosix).toSorted();
  const outsideRepo = [...specs].filter((spec) => !insideRepo(spec)).toSorted();
  const files = new Map<string, string>();
  const list = async (args: string[]) =>
    gitSpecs.length
      ? (
          await gitAsync(root, ['--literal-pathspecs', 'ls-files', '-z', ...args, '--', ...gitSpecs], {
            untrimmed: true,
            timeoutMs: 60_000,
            signal,
          })
        )
          .split('\0')
          .filter(Boolean)
      : [];
  const [staged, changed, untracked, ignored] = await Promise.all([
    list(['-s']),
    list(['-m']),
    list(['-o', '--exclude-standard']),
    list(['-o', '-i', '--exclude-standard', '--directory']),
  ]);
  for (const line of staged) {
    const [meta, path] = line.split('\t');
    const [mode, id] = (meta ?? '').split(' ');
    if (mode === '160000') throw new Uncertain(`${path} is a git submodule`);
    if (path && id) files.set(path, id);
  }
  const hashed = [...changed, ...untracked];
  const isIgnored = (path: string, dir: boolean) =>
    path.split('/').includes('node_modules') ||
    isIgnoredPathWithMatchObjects(path, dir ? normalized.ignoreDirMatchObjects : normalized.ignorePathMatchObjects);
  const walk = (path: string) => {
    if (isIgnored(path, true)) return;
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = posix.join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (!isIgnored(child, false)) hashed.push(child);
      if (hashed.length > UNTRACKED_FILE_CAP) throw new Uncertain('too many inputs outside git');
    }
  };
  for (const entry of ignored) {
    if (entry.endsWith('/')) walk(entry.slice(0, -1));
    else if (!isIgnored(entry, false)) hashed.push(entry);
  }
  for (const dir of scan.dirs) walk(toPosix(relative(root, dir)));
  for (const spec of outsideRepo) {
    const stat = statSync(join(root, spec), { throwIfNoEntry: false });
    if (stat?.isDirectory()) walk(toPosix(spec));
    else if (stat) hashed.push(toPosix(spec));
  }
  if (hashed.length > UNTRACKED_FILE_CAP) throw new Uncertain('too many inputs outside git');
  for (const name of expoEnvFiles(env)) {
    hashed.push(name);
    let text = '';
    try {
      text = readFileSync(join(root, name), 'utf8');
    } catch {}
    for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) scan.env.add(String(match[1]));
  }
  for (const file of scan.files) hashed.push(toPosix(relative(root, file)));
  await Promise.all(
    hashed.map(async (path) => {
      signal?.throwIfAborted();
      const full = join(root, path);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      files.set(path, stat?.isFile() ? blobId(await readFile(full)) : contentId(full));
    }),
  );

  const packageRows = [...packages]
    .map(([dir, info]) => [toPosix(relative(root, dir)), info.name, info.version, info.native, info.platforms])
    .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const { ignorePathMatchObjects, ignoreDirMatchObjects: _dirs, fileHookTransform: _hook, ...options } = normalized;
  const require = createRequire(import.meta.url);
  const identity = {
    schema: STATIC_SCHEMA,
    stim: STIM_VERSION,
    fingerprint: String(field(require('@expo/fingerprint/package.json'), 'version')),
    platform: target.platform,
    root: toPosix(relative(top, root)),
    options: {
      ...options,
      concurrentIoLimit: null,
      silent: null,
      debug: null,
      ignorePaths: ignorePathMatchObjects.map((match) => match.pattern),
      extraSources: (options.extraSources ?? []).map(({ reasons: _reasons, ...source }) => source),
    },
  };
  const nativePackages = [
    ...new Set([...packages.values()].filter((info) => linkedOn(info, target.platform)).map((info) => info.name)),
  ].toSorted();
  const digest = sha256(
    JSON.stringify({
      identity,
      files: [...files].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      extraContents,
      packages: packageRows,
      lockfile: lockfileDigest(root, top),
      env: [...scan.env].toSorted().map((name) => [name, envValueDigest(root, env[name])]),
    }),
  );
  return { digest, nativePackages };
}
