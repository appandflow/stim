import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LOCKFILES } from '@stim-cli/core/state';
import {
  DEFAULT_ANDROID_GRADLE_ROOT,
  DEFAULT_ANDROID_MODULE,
  DEFAULT_IOS_PROJECT_PATH,
  type AndroidLayout,
} from '../workspace/settings.ts';
import {
  canonicalJson,
  isUncertain,
  mergeInputs,
  sha256,
  type Input,
  type Layout,
  type NativeMode,
  type Platform,
  type Uncertain,
} from './key.ts';
import { canonicalPodfileLock } from './podfile-lock.ts';
import { compileIgnore, field, nativeSubset, pathForm, walk, within, type Roots, type WalkOptions } from './walk.ts';

const PATCH_DIRS = ['patches', 'cng-patches', '.yarn/patches'];
const APP_ROOT_SKIPPED = new Set(['node_modules', 'Pods', 'build', 'android', '.git', '.DS_Store', '.stim.json']);
const ANDROID_ROOT_SOURCES = [
  'settings.gradle',
  'settings.gradle.kts',
  'build.gradle',
  'build.gradle.kts',
  'gradle.properties',
  'gradle',
];
const MANIFEST_SKIPPED = new Set([
  'version',
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]);

export interface StaticTarget {
  platform: Platform;
  iosProjectPath?: string;
  androidLayout?: AndroidLayout | null;
  keepSigningFiles?: boolean;
}

export interface StaticContext {
  root: string;
  /** From `trackedPaths`: real paths git tracks, or null outside a git work tree. */
  tracked: ReadonlySet<string> | null;
  /** Whether the app resolves the `expo` package. */
  expoResolves: boolean;
  /** The evaluated app config, whose string values can name input files. */
  config?: unknown;
  /** The export of the project's `fingerprint.config.js`, as its loader child returns it. */
  fingerprintConfig?: unknown;
  /** Roots of native packages hashed by content: workspace links, `file:`, git and unclassified origins. */
  contentPackages?: readonly string[];
  hashes?: WalkOptions['hashes'];
}

export interface StaticInputs {
  native: NativeMode;
  layout: Layout;
  inputs: Input[];
  portable: boolean;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The nearest directory at or above `root` holding a lockfile, not past a git work tree top; else `root`. */
export function installRoot(root: string): string {
  for (let dir = root; ; dir = dirname(dir)) {
    if (LOCKFILES.some((name) => existsSync(join(dir, name)))) return dir;
    if (dirname(dir) === dir || existsSync(join(dir, '.git'))) return root;
  }
}

/**
 * Whether the platform's native directory is the project's own (`tracked`) or produced by `expo prebuild`
 * (`generated`). Git tracking decides, so running prebuild never changes the answer.
 */
export function nativeMode(
  { expoResolves, tracked }: Pick<StaticContext, 'expoResolves' | 'tracked'>,
  nativeDir: string,
): NativeMode | Uncertain {
  if (!expoResolves) return 'tracked';
  if (tracked === null)
    return existsSync(nativeDir)
      ? { uncertain: `${nativeDir} exists outside a git work tree, so it cannot be told apart from prebuild output` }
      : 'generated';
  for (const path of tracked) if (within(path, nativeDir)) return 'tracked';
  return 'generated';
}

/** `fingerprint.config.js` `extraSources`: file and dir entries become trees, contents entries `extra:<id>` rows. */
function projectFingerprintConfig(value: unknown, root: string): { trees: string[]; rows: Input[] } | Uncertain {
  const sources = field(value, 'extraSources');
  if (sources === undefined || sources === null) return { trees: [], rows: [] };
  if (!Array.isArray(sources)) return { uncertain: 'fingerprint.config.js extraSources is not an array' };
  const trees: string[] = [];
  const rows: Input[] = [];
  for (const source of sources) {
    const type = field(source, 'type');
    const filePath = field(source, 'filePath');
    const id = field(source, 'id');
    const contents = field(source, 'contents');
    if ((type === 'file' || type === 'dir') && typeof filePath === 'string') trees.push(resolve(root, filePath));
    else if (type === 'contents' && typeof id === 'string' && contents !== undefined)
      rows.push({
        name: `extra:${id}`,
        kind: 'config',
        hash: sha256(typeof contents === 'string' ? contents : canonicalJson(contents)),
      });
    else
      return {
        uncertain: `fingerprint.config.js has an extraSources entry stim cannot read: ${JSON.stringify(source)}`,
      };
  }
  return { trees, rows };
}

/**
 * Files and directories the app config names: every string value that resolves to an existing path inside the app or
 * its install root, other than the app, its ancestors, installed packages and the native directories, which have rows
 * of their own when they are inputs. Expo's `_internal` block holds the config loader's own paths.
 */
function configNamedPaths(config: unknown, roots: Roots, nativeDirs: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    else if (typeof value === 'string' && value && value.length < 1024 && !/[\0\n]/.test(value)) {
      let real: string;
      try {
        real = realpathSync.native(isAbsolute(value) ? value : resolve(roots.project, value));
      } catch {
        return;
      }
      if (
        (within(real, roots.project) || within(real, roots.install)) &&
        !within(roots.project, real) &&
        !relative(roots.install, real).split(sep).includes('node_modules') &&
        !nativeDirs.some((dir) => within(real, dir))
      )
        found.add(real);
    }
  };
  visit(
    Object.fromEntries(
      Object.entries(config && typeof config === 'object' ? config : {}).filter(([key]) => key !== '_internal'),
    ),
  );
  return [...found];
}

function yamlBlock(text: string | null, key: string): string[] {
  const lines = text?.split(/\r?\n/) ?? [];
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break;
    if (line.trim()) block.push(line.trim());
  }
  return block;
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * Patch files wherever they live and the `patched-dependencies` row: pnpm's `patchedDependencies` (lockfile,
 * `package.json`, `pnpm-workspace.yaml`), yarn `patch:` references and the `patch-package` directory.
 */
function patches(roots: Roots): { files: string[]; dirs: string[]; row: Input | null } | Uncertain {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const lock = yamlBlock(readText(join(roots.install, 'pnpm-lock.yaml')), 'patchedDependencies');
  for (const line of lock) {
    const path = /^path:\s*(.+)$/.exec(line)?.[1];
    if (path) files.add(resolve(roots.install, unquote(path)));
  }
  for (const line of yamlBlock(readText(join(roots.install, 'pnpm-workspace.yaml')), 'patchedDependencies')) {
    const path = /^[^:]+:\s*['"]?([^'"]+\.patch)['"]?$/.exec(line)?.[1];
    if (path) files.add(resolve(roots.install, path));
  }
  for (const dir of new Set([roots.project, roots.install])) {
    const manifest = readJson(join(dir, 'package.json'));
    const pnpm = field(field(manifest, 'pnpm'), 'patchedDependencies');
    for (const path of Object.values(pnpm && typeof pnpm === 'object' ? pnpm : {}))
      if (typeof path === 'string') files.add(resolve(dir, path));
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions']) {
      const specs = field(manifest, key);
      for (const spec of Object.values(specs && typeof specs === 'object' ? specs : {})) {
        const path = typeof spec === 'string' ? /^patch:.*#(~\/|\.\/)?([^:&#]+\.patch)/.exec(spec) : null;
        if (path?.[2]) files.add(resolve(path[1] === '~/' ? roots.install : dir, decodeURIComponent(path[2])));
      }
    }
    const script = field(field(manifest, 'scripts'), 'postinstall');
    if (typeof script === 'string' && script.includes('patch-package')) {
      const flag = /--patch-dir(?:=|\s+)(\S+)/.exec(script);
      const name = flag?.[1] ? unquote(flag[1]) : 'patches';
      const patchDir = resolve(dir, name);
      if (/[$`]/.test(name) || !(within(patchDir, roots.project) || within(patchDir, roots.install)))
        return { uncertain: `the patch-package directory in ${join(dir, 'package.json')} cannot be resolved` };
      dirs.add(patchDir);
    }
  }
  const named = [...files].map((path) => pathForm(path, roots)).toSorted();
  const row: Input | null =
    lock.length || named.length
      ? { name: 'patched-dependencies', kind: 'manifest', hash: sha256(canonicalJson({ lock, files: named })) }
      : null;
  return { files: [...files], dirs: [...dirs], row };
}

/** The native subset of each native package directly under a directory of local modules. */
function moduleDirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return [];
    const subset = nativeSubset(path);
    return subset[0] !== path || existsSync(join(path, 'expo-module.config.json')) ? subset : [];
  });
}

function nativeTrees(project: string, nativeDir: string, target: StaticTarget): string[] {
  const layout = target.platform === 'android' && target.androidLayout?.custom ? target.androidLayout : null;
  if (!layout) return [nativeDir];
  if (nativeDir !== project) return [nativeDir, layout.moduleDir];
  return [...ANDROID_ROOT_SOURCES.map((name) => join(nativeDir, name)), layout.moduleDir];
}

export function targetLayout(target: StaticTarget): Layout {
  const ios = target.platform === 'ios';
  return {
    projectPath: ios ? (target.iosProjectPath ?? DEFAULT_IOS_PROJECT_PATH) : null,
    gradleRoot: ios ? null : (target.androidLayout?.gradleRootRelative ?? DEFAULT_ANDROID_GRADLE_ROOT),
    module: ios ? null : (target.androidLayout?.module ?? DEFAULT_ANDROID_MODULE),
  };
}

/** The real path of the platform's native directory, or its declared path while it does not exist. */
export function nativeDirectory(project: string, target: StaticTarget): string {
  const declared =
    target.platform === 'ios'
      ? resolve(project, target.iosProjectPath ?? DEFAULT_IOS_PROJECT_PATH)
      : (target.androidLayout?.gradleRoot ?? join(project, 'android'));
  return existsSync(declared) ? realpathSync.native(declared) : declared;
}

/**
 * The inputs stim reads without running project code: files under the tracked native directory, local native
 * packages, patches, config-named files and `fingerprint.config.js` sources, the projected `package.json` and the
 * patch manifest. Rows from evaluating the app config and autolinking are not part of this set.
 */
export function staticInputs(context: StaticContext, target: StaticTarget): StaticInputs | Uncertain {
  const project = realpathSync.native(context.root);
  const roots: Roots = { project, install: installRoot(project) };
  if ([project, roots.install].some((dir) => existsSync(join(dir, '.pnp.cjs'))))
    return {
      uncertain: 'Yarn Plug-n-Play installs have no node_modules to read',
      remedy: 'Set nodeLinker: node-modules.',
    };
  const ios = target.platform === 'ios';
  const layout = targetLayout(target);
  const nativeDir = nativeDirectory(project, target);
  const native = nativeMode(context, nativeDir);
  if (isUncertain(native)) return native;
  const extra = projectFingerprintConfig(context.fingerprintConfig, project);
  if (isUncertain(extra)) return extra;
  const patched = patches(roots);
  if (isUncertain(patched)) return patched;
  const manifest = readJson(join(project, 'package.json'));
  const autolinking = field(field(manifest, 'expo'), 'autolinking');
  const moduleRoots = [join(project, 'modules')];
  for (const options of [autolinking, field(autolinking, 'ios'), field(autolinking, 'android')]) {
    for (const path of [field(options, 'nativeModulesDir'), field(options, 'searchPaths')].flat())
      if (typeof path === 'string' && !path.split(/[\\/]/).includes('node_modules'))
        moduleRoots.push(resolve(project, path));
  }
  const codegen = field(field(manifest, 'codegenConfig'), 'jsSrcsDir');
  const trees = [
    ...(native === 'tracked' ? nativeTrees(project, nativeDir, target) : []),
    ...[project, roots.install].flatMap((dir) => PATCH_DIRS.map((name) => join(dir, name))),
    ...patched.dirs,
    ...patched.files,
    ...moduleRoots.flatMap(moduleDirs),
    ...(context.contentPackages ?? []).flatMap((dir) => nativeSubset(dir)),
    ...(typeof codegen === 'string' ? [resolve(project, codegen)] : []),
    ...configNamedPaths(
      context.config,
      roots,
      [join(project, DEFAULT_IOS_PROJECT_PATH), join(project, DEFAULT_ANDROID_GRADLE_ROOT), nativeDir].filter(
        (dir) => !within(project, dir),
      ),
    ),
    ...extra.trees,
  ];
  const podfileLock = join(nativeDir, 'Podfile.lock');
  const walked = walk({
    roots,
    trees,
    ignore: compileIgnore(readText(join(project, '.fingerprintignore')) ?? ''),
    tracked: context.tracked,
    skip: ios && nativeDir === project ? [...APP_ROOT_SKIPPED].map((name) => join(project, name)) : [],
    trackedOnly: ios && native === 'tracked' ? [join(nativeDir, 'main.jsbundle'), join(nativeDir, 'assets')] : [],
    keepSigningFiles: target.keepSigningFiles,
    hashes: context.hashes,
    transforms: new Map(
      ios
        ? [
            [
              podfileLock,
              (bytes: Buffer) => canonicalPodfileLock(bytes.toString('utf8'), join(nativeDir, 'Pods'), context.root),
            ],
          ]
        : [],
    ),
  });
  if (isUncertain(walked)) return walked;
  const projected = Object.fromEntries(
    Object.entries(manifest && typeof manifest === 'object' ? manifest : {}).filter(
      ([key]) => !MANIFEST_SKIPPED.has(key),
    ),
  );
  const inputs: Input[] = [...walked.inputs, ...extra.rows, ...(patched.row ? [patched.row] : [])];
  if (manifest !== null)
    inputs.push({ name: 'package.json#native', kind: 'manifest', hash: sha256(canonicalJson(projected)) });
  try {
    return { native, layout, inputs: mergeInputs(inputs), portable: walked.portable };
  } catch (error) {
    return { uncertain: `${String(error instanceof Error ? error.message : error)}, so they cannot be told apart` };
  }
}
