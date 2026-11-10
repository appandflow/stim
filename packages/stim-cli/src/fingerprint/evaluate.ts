import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNodeBin } from '@stim-cli/core/toolchain';
import type { StimContext } from '@stim-cli/core';
import type { BuildFingerprintSource } from '@stim-cli/core/protocol';
import { getExecutor } from '../exec.ts';
import { makeTemporaryDirectory, removeTemporaryEntry } from '../temporary.ts';
import { processContext } from '../cli-operation.ts';
import { withFingerprintOwnership } from '../engine/fingerprint-ownership.ts';
import {
  entryPoints,
  findPackage,
  installedPackage,
  packageIdentity,
  packageRoot,
  packageRows,
  projectPackagePath,
} from './closure.ts';
import {
  buildEnvRows,
  buildScripts,
  embedEnv,
  enumerationRow,
  envRows,
  evaluatorEnv,
  isDenied,
  isSessionName,
  privateReplayEnv,
  workspaceEnv,
  scriptEnvNames,
  templateScripts,
} from './env.ts';
import { gitLocation, trackedPaths } from './git-index.ts';
import {
  IndexSession,
  indexDir,
  listing,
  relocate,
  startedAt,
  traceReads,
  writeWorkspaceEnv,
  type Derived,
  type PackageEntry,
  type PartRecord,
  type Provenance,
  type ReadKind,
} from './index-store.ts';
import { lockfileClassifier, type Classifier } from './provenance.ts';
import { installRoot, nativeDirectory, nativeMode, staticInputs, targetLayout, type StaticTarget } from './inputs.ts';
import {
  byCodeUnit,
  canonicalJson,
  FINGERPRINT_SCHEMA,
  isUncertain,
  mergeInputs,
  preimage,
  preimageHash,
  sha256,
  type Input,
  type NativeMode,
  type Platform,
  type Uncertain,
} from './key.ts';
import { nativeSubset, pathForm, walk, within, type Roots } from './walk.ts';
import { replayFiles } from './replay.ts';

type PartName = 'config' | 'configEmbedded' | 'expoAutolinking' | 'rnConfig';
export interface EvalUncertain extends Uncertain {
  evaluator?: PartName;
  stderrTail?: string[];
}
export interface FingerprintOptions {
  /** The requester's env, which the native build also runs under. */
  env: NodeJS.ProcessEnv;
  /** The config mode `expo-constants` embeds with: `development` for a Debug configuration or variant. */
  embedMode: 'development' | 'production';
  signal?: AbortSignal;
  operation?: StimContext;
  /** `skip` computes without an index; `refresh` computes without reading it and records the result. Default `use`. */
  index?: 'use' | 'skip' | 'refresh';
  replay?: { native: NativeMode; sources: BuildFingerprintSource[]; allowChanges?: boolean };
}
export interface Fingerprint {
  schema: number;
  hash: string;
  platform: Platform;
  native: NativeMode;
  inputs: Input[];
  nativePackages: string[];
  configModules: string[];
  config: Record<string, unknown> | null;
  portable: boolean;
  /** Parts whose result came from code that spawned, connected or loaded native code, or ran without ESM capture. */
  opaque: string[];
  /** `index` when any evaluator part came from the validation index instead of a child. */
  from: 'evaluated' | 'index';
  /** The keys the project's `fingerprint.config.js` exports; Stim applies only `extraSources`. */
  fingerprintConfigKeys: string[];
}
interface Trace {
  env: string[];
  enumerators: string[];
  /** `resolve` is a directory module resolution searched; `tree` a recursive listing, the only listing hashed. */
  reads: { path: string; kind: ReadKind | 'resolve'; hash?: string }[];
  modules: { path: string; hash: string }[];
  opaque: string[];
}
interface Part {
  name: PartName;
  output: unknown;
  /** Whether fp-eval.cjs produced the output, which then wraps what it evaluated. */
  wrapped: boolean;
  envNames: string[];
  derived: Derived;
  env: Record<string, string>;
  fromIndex: boolean;
  /** Records the part in the index; called only for a part the key uses. */
  keep: () => void;
}

/** Env names Node reads below `process.env` (at startup, or in `os.homedir()` and `os.tmpdir()`); a part is reused only while they hold. */
const STARTUP_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_PRESERVE_SYMLINKS', 'NODE_ICU_DATA', 'HOME', 'TMPDIR'];

const TIMEOUT_MS = 60_000;
const unrecorded = (): void => {};
const ABSENT = sha256(canonicalJson(['absent']));
const SCRIPT = /\.(?:[cm]?js|[cm]?ts)$/;
/** The static app config, whose evaluated form is the `config` row, version fields removed. */
const APP_CONFIG_FILES = ['app.json', 'app.config.json'];
const SKIPPED_READS = new Set(['package.json', 'Podfile.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']);
const VERSION_FIELDS = [
  ['version'],
  ['ios', 'version'],
  ['ios', 'buildNumber'],
  ['android', 'version'],
  ['android', 'versionCode'],
];
const LABELS: Record<PartName, [string, string]> = {
  config: ['config (expo/config getConfig with plugins)', 'npx expo config --type prebuild'],
  configEmbedded: [
    'configEmbedded (expo/config getConfig as expo-constants embeds it)',
    'npx expo config --type public',
  ],
  expoAutolinking: ['expoAutolinking (expo-modules-autolinking resolve)', 'npx expo-modules-autolinking resolve'],
  rnConfig: ['rnConfig (React Native autolinking config)', 'npx react-native config'],
};

const shim = (name: string) =>
  ['../shim', '../../shim']
    .map((rel) => resolve(dirname(fileURLToPath(import.meta.url)), rel, name))
    .find((path) => existsSync(path)) ?? '';
const SHIMS = dirname(shim('fp-eval.cjs'));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const isTrace = (value: unknown): value is Trace =>
  isRecord(value) && ['env', 'enumerators', 'reads', 'modules', 'opaque'].every((key) => Array.isArray(value[key]));
const failed = (part: PartName, why: string): EvalUncertain => ({
  uncertain: `${LABELS[part][0]} ${why}`,
  evaluator: part,
  remedy: LABELS[part][1],
});

function readEvaluatorOutput(path: string): string {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return '';
  if (info.size > 64 * 1024 * 1024) throw new Error('fingerprint output exceeded its size limit');
  return readFileSync(path, 'utf8');
}

async function run(
  part: PartName,
  node: string,
  args: string[],
  root: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<{ result: string; stdout: string; trace: Trace } | EvalUncertain> {
  if (signal?.aborted) return failed(part, 'was cancelled');
  const directory = parentTemporaryRoot
    ? mkdtempSync(join(parentTemporaryRoot, 'part-'))
    : makeTemporaryDirectory(root, 'stim-fingerprint-', operation);
  const resultPath = join(directory, 'result.json');
  const tracePath = join(directory, 'trace.json');
  const childSignal = signal ?? new AbortController().signal;
  let retain = false;
  try {
    const stdout = await getExecutor().runFileAsync(node, ['--require', join(SHIMS, 'fp-trace.cjs'), ...args], {
      cwd: root,
      env: {
        ...env,
        STIM_FP_CONTROL: JSON.stringify({ result: resultPath, trace: tracePath, original: env.STIM_FP_CONTROL }),
      },
      omitEnv: Object.keys(operation?.env ?? processContext(root).env).filter(
        (name) => !(name in env) && name !== 'STIM_FP_CONTROL',
      ),
      timeoutMs: TIMEOUT_MS,
      signal: childSignal,
      context: operation,
      declareFor: operation,
      untrimmed: true,
      redact: Object.values(env).filter((value) => value.length > 0),
    });
    let trace: unknown;
    try {
      trace = JSON.parse(readEvaluatorOutput(tracePath));
    } catch {
      return failed(part, 'wrote no readable trace');
    }
    if (!isTrace(trace)) return failed(part, 'wrote no readable trace');
    return { result: readEvaluatorOutput(resultPath), stdout, trace };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error) {
      retain = true;
      const remedy = 'remedy' in error && typeof error.remedy === 'string' ? `${error.remedy} ` : '';
      throw Object.assign(error, { remedy: `${remedy}After confirming cleanup, remove ${directory}.` });
    }
    signal?.throwIfAborted();
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
    return {
      ...failed(part, status === null ? 'could not finish evaluation' : `exited ${status}`),
      stderrTail: stderr
        .trimEnd()
        .split('\n')
        .filter((line) => line && !/^\s+at /.test(line))
        .slice(-20),
    };
  } finally {
    if (!retain) removeTemporaryEntry(directory);
  }
}

function parse(part: PartName, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return failed(part, 'printed output that is not JSON');
  }
}

/** Absolute strings in their layout-independent path form; arrays of autolinking output in a stable order. */
function normalize(value: unknown, roots: Roots, sortArrays: boolean): unknown {
  if (typeof value === 'string') {
    if (!isAbsolute(value)) return value;
    let path = resolve(value);
    try {
      path = realpathSync.native(path);
    } catch {
      if (!within(path, roots.project) && !within(path, roots.install)) return value;
    }
    return pathForm(path, roots);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item, roots, sortArrays));
    if (!sortArrays) return items;
    const key = (item: unknown) => {
      const named = ['name', 'packageName', 'podName']
        .map((field) => record(item)[field])
        .find((v) => typeof v === 'string');
      return `${typeof named === 'string' ? named : ''}\0${canonicalJson(item)}`;
    };
    return items.toSorted((a, b) => byCodeUnit(key(a), key(b)));
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, normalize(item, roots, sortArrays)]),
    );
  return value;
}

/** The config without loader paths and the version fields stim leaves out of the key, in path form. */
function keyedConfig(config: unknown, roots: Roots): string {
  const copy = structuredClone(record(config));
  delete copy['_internal'];
  for (const path of VERSION_FIELDS) {
    const owner = path.length === 1 ? copy : record(copy[path[0] ?? '']);
    delete owner[path.at(-1) ?? ''];
  }
  return canonicalJson(normalize(copy, roots, false));
}

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function realForm(path: string, roots: Roots): string {
  try {
    return pathForm(realpathSync.native(path), roots);
  } catch {
    return pathForm(resolve(path), roots);
  }
}

const configRow = (name: string, config: unknown, roots: Roots): Input => ({
  name,
  kind: 'config',
  hash: sha256(keyedConfig(config, roots)),
});

function fileRow(path: string, roots: Roots, session?: IndexSession | null): Input {
  let real = path;
  let hash = ABSENT;
  try {
    real = realpathSync.native(path);
    const content = () => sha256(readFileSync(real));
    hash = session ? session.hashes.hash(real, content) : content();
  } catch {}
  return { name: pathForm(real, roots), kind: 'file', hash };
}

const envCandidates = (root: string, mode: string) =>
  [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'].map((name) => join(root, name));

/**
 * What one part read, as rows: files and modules inside the app, probes of the config parts, and the packages it
 * loaded code from. Env rows are left to the caller, which values them from the env the part ran under.
 */
function traceRows(
  name: PartName,
  trace: Trace,
  roots: Roots,
  excluded: readonly string[],
  owner: (path: string) => string | null,
  content: (dir: string) => boolean,
): Uncertain | Omit<Derived, 'autolinking'> {
  const rows: Input[] = [];
  const inApp = (path: string) =>
    (within(path, roots.project) || within(path, roots.install)) && !path.split(sep).includes('node_modules');
  const packages = new Set<string>();
  const modules: string[] = [];
  let portable = true;
  const contentRow = (path: string): Input => {
    const row = fileRow(path, roots);
    if (row.name.startsWith('npm:') && !projectPackagePath(roots.project, realOr(path))) portable = false;
    return row;
  };
  const ours = (path: string) => within(path, SHIMS) || excluded.some((dir) => within(path, dir));
  for (const { path, hash } of trace.modules) {
    if (ours(path) || SKIPPED_READS.has(basename(path))) continue;
    const dir = owner(path);
    if (dir) {
      packages.add(dir);
      if (content(dir)) rows.push(contentRow(path));
    } else if (existsSync(path)) {
      const row = fileRow(path, roots);
      modules.push(row.name);
      rows.push(row);
    } else rows.push({ name: `virtual:${pathForm(path, roots)}`, kind: 'file', hash });
  }
  const compiled = new Set(trace.modules.map((module) => module.path));
  const configPart = name === 'config' || name === 'configEmbedded';
  for (const { path, kind, hash } of trace.reads) {
    if (ours(path)) continue;
    const dir = owner(path);
    if (packageRoot(path) && (!dir || !content(dir))) continue;
    if (kind === 'resolve') continue;
    if (kind !== 'file') {
      if (inApp(path) && (name === 'config' || name === 'configEmbedded'))
        rows.push(
          kind === 'dir' || kind === 'tree'
            ? {
                name: `${kind}:${realForm(path, roots)}`,
                kind: 'file',
                hash: (kind === 'tree' ? hash : listing(path)) ?? ABSENT,
              }
            : { name: `exists:${realForm(path, roots)}`, kind: 'file', hash: sha256(kind) },
        );
      continue;
    }
    if (SKIPPED_READS.has(basename(path))) continue;
    if (configPart && APP_CONFIG_FILES.some((file) => path === join(roots.project, file))) continue;
    if (
      trace.opaque.includes('module.registerHooks missing') &&
      SCRIPT.test(path) &&
      inApp(path) &&
      !compiled.has(path)
    )
      return { uncertain: `${path} was read as a module this Node cannot capture; use Node 22.15 or later` };
    rows.push(dir && content(dir) ? contentRow(path) : fileRow(path, roots));
  }
  return {
    rows,
    packages: [...packages],
    modules,
    opaque: trace.opaque.map((call) => `${name}: ${call}`),
    enumerated: trace.enumerators.some(inApp),
    portable,
  };
}

const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const pathStrings = (value: unknown): string[] => strings(value).filter((string) => isAbsolute(string));

/** Which autolinking setup a tracked native directory uses: Expo's command, the community CLI's, or neither. */
function trackedAutolinking(nativeDir: string, platform: Platform): 'expo' | 'bare' | null {
  const file = (platform === 'ios' ? ['Podfile'] : ['settings.gradle', 'settings.gradle.kts'])
    .map((name) => join(nativeDir, name))
    .find((path) => existsSync(path));
  const text = file ? readFileSync(file, 'utf8') : '';
  if (
    /expo\/bin\/autolinking|expo-modules-autolinking[\s\S]*react-native-config|expoAutolinking\.rnConfigCommand/.test(
      text,
    )
  )
    return 'expo';
  return /use_native_modules!|autolinkLibrariesFromCommand\(|applyNativeModulesSettingsGradle/.test(text)
    ? 'bare'
    : null;
}

function versionAtLeast(version: unknown, major: number, minor: number): boolean {
  const [a = 0, b = 0] = String(version).split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

let evaluatorDigest: string | null = null;
/** The evaluator shims' digest: a record is reused only by the shims that produced it. */
const evaluatorKey = (): string =>
  (evaluatorDigest ??= sha256(
    ['fp-eval.cjs', 'fp-trace.cjs'].map((name) => readFileSync(join(SHIMS, name))).join('\0'),
  ));

export interface FingerprintRuntime {
  node: string;
  evaluator: string;
  packages: Record<string, string | null>;
}

export function fingerprintRuntime(root: string, env: NodeJS.ProcessEnv): FingerprintRuntime | Uncertain {
  const node = projectNodeBin(root, env)?.version ?? process.version;
  const version = /^v?(\d+\.\d+)/.exec(node)?.[1];
  if (!version) return { uncertain: `cannot identify the project's Node version ${node}` };
  const expo = findPackage(root, 'expo');
  const expoCli = expo && findPackage(expo, '@expo/cli');
  const rnCli = findPackage(root, '@react-native-community/cli');
  const constants = findPackage(root, 'expo-constants');
  const dirs: Record<string, string | null> = {
    expo,
    '@expo/cli': expoCli,
    '@expo/config': expo && findPackage(expo, '@expo/config'),
    '@expo/config-plugins': expo && findPackage(expo, '@expo/config-plugins'),
    '@expo/env': expoCli && findPackage(expoCli, '@expo/env'),
    'expo-modules-autolinking':
      expo && (findPackage(expo, 'expo-modules-autolinking') ?? findPackage(root, 'expo-modules-autolinking')),
    'expo-constants': constants,
    'expo-constants:@expo/env': constants && findPackage(constants, '@expo/env'),
    'react-native': findPackage(root, 'react-native'),
    '@react-native-community/cli': rnCli,
    '@react-native-community/cli-config': rnCli && findPackage(rnCli, '@react-native-community/cli-config'),
  };
  const packages: Record<string, string | null> = {};
  for (const [name, dir] of Object.entries(dirs)) {
    const identity = dir ? packageIdentity(dir) : null;
    if (dir && (!identity || !identity.version)) return { uncertain: `cannot identify evaluator package ${name}` };
    packages[name] = identity?.version ?? null;
  }
  if (
    expo &&
    ['@expo/cli', '@expo/config', '@expo/config-plugins', '@expo/env', 'expo-modules-autolinking'].some(
      (name) => !packages[name],
    )
  )
    return { uncertain: 'cannot identify the project Expo evaluator packages' };
  return { node: version, evaluator: evaluatorKey(), packages };
}

/**
 * The env digest a part is checked against: a value's hash, a path's in its relocated form, or for `*` (code, its own
 * or a dependency's, enumerated the env) every name and value the part ran with but those of the shell session.
 */
function envDigest(env: Record<string, string>, roots: Roots): (name: string) => string | null {
  return (name) => {
    if (name === '*')
      return sha256(
        canonicalJson(
          Object.entries(env)
            .filter(([key]) => !isSessionName(key))
            .toSorted(([a], [b]) => byCodeUnit(a, b)),
        ),
      );
    const value = env[name];
    if (value === undefined) return null;
    return sha256(canonicalJson(isAbsolute(value) ? ['path', relocate(resolve(value), roots)] : ['value', value]));
  };
}

/** Normalized autolinking output: `resolve`'s whole output, or the `dependencies` of the React Native config. */
function autolinkingHash(name: PartName, output: unknown, wrapped: boolean, roots: Roots): string | null {
  if (name === 'expoAutolinking') return sha256(canonicalJson(normalize(output, roots, true)));
  if (name !== 'rnConfig') return null;
  const dependencies = record(wrapped ? record(output).config : output).dependencies;
  return typeof dependencies === 'object' && dependencies !== null
    ? sha256(canonicalJson(normalize(dependencies, roots, true)))
    : null;
}

const scriptNames = async (paths: string[]) =>
  (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).flatMap(scriptEnvNames);

/**
 * The env names the native build scripts read: the tracked native directory's or the prebuild template's, React
 * Native's, autolinking's and the Gradle plugin's, and every package `scan` adds. An installed package's names are
 * kept in the index under its `package.json`. Scans run in the background; `settle` waits for every one started.
 * Without an index, the app's own dependencies are walked ahead, since autolinking names most native packages only
 * when its child exits; a walked package adds names only once `scan` names it.
 */
function buildEnvNames(
  root: string,
  native: NativeMode,
  nativeDir: string,
  expo: string | null,
  session: IndexSession | null,
): { names: string[]; scanned: Set<string>; scan: (dirs: Iterable<string>) => void; settle: () => Promise<void> } {
  const reactNative = findPackage(root, 'react-native');
  const scanned = new Set<string>();
  const names: string[] = [];
  const pending: Promise<unknown>[] = [];
  let failure: unknown = null;
  const walked = new Map<string, Promise<string[]>>();
  const walkScripts = (dir: string) => {
    let found = walked.get(dir);
    if (!found) walked.set(dir, (found = buildScripts(dir).then(scriptNames)));
    return found;
  };
  const track = (found: Promise<string[]>, entry?: PackageEntry) =>
    pending.push(
      found.then(
        (list) => {
          if (entry) entry.scan = list;
          names.push(...list);
          return list;
        },
        (error: unknown) => {
          failure ??= error;
        },
      ),
    );
  if (native === 'tracked') track(buildScripts(nativeDir).then(scriptNames));
  if (native === 'generated' && expo && existsSync(join(expo, 'template.tgz'))) {
    const entry = session?.pkg(expo);
    const template =
      (entry?.provenance?.mode === 'identity' ? entry.template : undefined) ??
      templateScripts(join(expo, 'template.tgz')).flatMap(scriptEnvNames);
    if (entry) entry.template = template;
    names.push(...template);
  }
  const scan = (dirs: Iterable<string>) => {
    for (const dir of dirs) {
      if (scanned.has(dir)) continue;
      scanned.add(dir);
      const entry = installedPackage(dir) ? session?.pkg(dir) : undefined;
      const known = entry?.provenance?.mode === 'identity' ? entry.scan : undefined;
      track(known ? Promise.resolve(known) : walkScripts(dir), entry);
    }
  };
  if (!session) {
    let app: Record<string, unknown> = {};
    try {
      app = record(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
    } catch {}
    for (const name of new Set([
      ...Object.keys(record(app.dependencies)),
      ...Object.keys(record(app.devDependencies)),
    ])) {
      const dir = findPackage(root, name);
      if (dir) walkScripts(dir).catch(() => {});
    }
  }
  const settle = async () => {
    await Promise.all(pending);
    if (failure) throw failure;
  };
  scan(
    [
      reactNative,
      expo && findPackage(expo, 'expo-modules-autolinking'),
      reactNative && findPackage(reactNative, '@react-native/gradle-plugin'),
    ].filter((dir): dir is string => Boolean(dir)),
  );
  return { names, scanned, scan, settle };
}

/**
 * The identity and provenance of each package a part loaded or the entry points name. A copy the lockfile does not
 * show as a registry tarball is identified by the digest of its native files instead.
 */
function packageIdentities(
  dirs: Iterable<string>,
  roots: Roots,
  session: IndexSession | null,
  classify: () => Classifier,
  namedNativePaths: Readonly<Record<string, readonly string[]>> = {},
): Uncertain | { name: string; version: string; provenance: Provenance; content?: string }[] {
  const identities: { name: string; version: string; provenance: Provenance; content?: string }[] = [];
  for (const dir of new Set(dirs)) {
    const entry: PackageEntry = session?.pkg(dir) ?? { read: { path: dir, kind: 'package' } };
    if (entry.name === undefined) {
      const identity = packageIdentity(dir);
      entry.name = identity?.name ?? null;
      entry.version = identity?.version ?? '';
    }
    if (entry.name === null) continue;
    const identity = { name: entry.name, version: entry.version ?? '' };
    entry.provenance ??= classify()(realOr(dir), identity);
    if (entry.provenance.mode === 'identity') {
      identities.push({ ...identity, provenance: entry.provenance });
      continue;
    }
    const walked = walk({
      roots,
      trees: nativeSubset(dir, namedNativePaths[realOr(dir)] ?? []),
      tracked: null,
      hashes: session?.hashes,
    });
    if (isUncertain(walked)) return walked;
    const content = sha256(canonicalJson(walked.inputs.map((input) => [input.name, input.hash])));
    identities.push({ ...identity, provenance: entry.provenance, content });
  }
  return identities;
}

function autolinkedPackages(
  paths: Set<string>,
  roots: Roots,
): { packages: Set<string>; contentPackages: Set<string> } | { uncertain: string } {
  const packages = new Set<string>();
  const contentPackages = new Set<string>();
  for (const path of paths) {
    const dir = packageRoot(path);
    if (dir) {
      packages.add(dir);
      continue;
    }
    let candidate = path;
    while (
      candidate !== roots.project &&
      candidate !== roots.install &&
      dirname(candidate) !== candidate &&
      !existsSync(join(candidate, 'package.json'))
    )
      candidate = dirname(candidate);
    if (existsSync(join(candidate, 'package.json')) && candidate !== roots.project && candidate !== roots.install)
      contentPackages.add(candidate);
    else if (!within(path, roots.project) && !within(path, roots.install))
      return { uncertain: `autolinking names ${path}, which belongs to no package stim can hash` };
  }
  return { packages, contentPackages };
}

function addExpoNamedPaths(output: unknown, owners: Iterable<string>, named: Record<string, string[]>): void {
  const modules = record(output).modules;
  const directories = [...owners].toSorted((a, b) => b.length - a.length);
  for (const module of Array.isArray(modules) ? modules : []) {
    const entry = record(module);
    for (const collection of [entry.pods, entry.projects, entry.plugins]) {
      for (const item of Array.isArray(collection) ? collection : []) {
        const descriptor = record(item);
        for (const path of [descriptor.podspecDir, descriptor.sourceDir]) {
          if (typeof path !== 'string' || !isAbsolute(path)) continue;
          const actual = realOr(path);
          const owner = directories.find((dir) => within(actual, realOr(dir)));
          if (!owner || realOr(owner) === actual) continue;
          (named[owner] ??= []).push(path);
          if (owner !== realOr(owner)) (named[realOr(owner)] ??= []).push(path);
        }
      }
    }
  }
}

function rnNativePaths(root: string, platforms: Record<string, unknown>): string[] {
  const ios = record(platforms.ios);
  const android = record(platforms.android);
  const names = [ios, android].flatMap((platform) =>
    [platform.sourceDir, platform.podspecPath, platform.cmakeListsPath, platform.cxxModuleCMakeListsPath].flatMap(
      (path) => (typeof path === 'string' && path ? [resolve(root, path)] : []),
    ),
  );
  for (const path of [ios.podspecPath, android.cmakeListsPath, android.cxxModuleCMakeListsPath])
    if (typeof path === 'string' && path) names.push(dirname(resolve(root, path)));
  return names;
}

async function evaluate(
  roots: Roots,
  platform: Platform,
  native: NativeMode,
  nativeDir: string,
  opts: FingerprintOptions,
  session: IndexSession | null,
  settled: AbortSignal,
  running: Promise<unknown>[],
) {
  const root = roots.project;
  let outsideValue = false;
  const form = (path: string) => {
    const keyed = realForm(path, roots);
    if (keyed.startsWith('outside:')) outsideValue = true;
    if (keyed.startsWith('npm:') && !projectPackagePath(root, realOr(path))) outsideValue = true;
    return keyed;
  };
  const env = evaluatorEnv(opts.env, root, platform);
  const pinned = projectNodeBin(root, opts.env);
  const node = pinned ? join(pinned.bin, process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;
  const evaluator = join(SHIMS, 'fp-eval.cjs');
  if (!existsSync(evaluator)) return { uncertain: 'the Stim installation is missing shim/fp-eval.cjs' };
  const expo = findPackage(root, 'expo');
  const excluded = [nativeDir, join(root, 'ios'), join(root, 'android')];
  const owners = new Map<string, string | null>();
  const owner = (path: string) => {
    const dir = packageRoot(path);
    if (!dir) return null;
    if (!owners.has(dir)) owners.set(dir, installedPackage(path));
    return owners.get(dir) ?? null;
  };
  let lockfile: Classifier | null = null;
  const classify = () => (lockfile ??= lockfileClassifier(roots.install).classify);
  const content = (dir: string): boolean => {
    const identity = packageIdentity(realOr(dir));
    return !identity || classify()(realOr(dir), identity).mode === 'content';
  };
  const spawnOne = async (
    name: PartName,
    args: string[],
    partEnv = env,
    slot: string = name,
    signal = opts.signal ? AbortSignal.any([opts.signal, settled]) : settled,
  ): Promise<Part | EvalUncertain> => {
    const wrapped = args[0] === evaluator;
    const digest = envDigest(partEnv, roots);
    const variant = name === 'rnConfig' && wrapped ? 'rnConfig:rn' : slot;
    const cached = session?.part(variant, digest);
    if (cached)
      return {
        name,
        output: cached.output,
        wrapped,
        envNames: cached.envNames,
        derived: cached.derived,
        env: partEnv,
        fromIndex: true,
        keep: unrecorded,
      };
    const since = session?.since ?? 0n;
    const done = await run(name, node, args, root, partEnv, signal, opts.operation);
    if (isUncertain(done)) return done;
    const output = parse(name, wrapped ? done.result : done.stdout);
    if (isUncertain(output)) return output;
    const traced = traceRows(name, done.trace, roots, excluded, owner, content);
    if (isUncertain(traced)) return traced;
    const derived: Derived = { ...traced, autolinking: autolinkingHash(name, output, wrapped, roots) };
    let keep = unrecorded;
    if (session && done.trace.opaque.length === 0) {
      const modes = [record(output).mode, partEnv.NODE_ENV, 'development', 'production'];
      const candidates = new Set(
        name === 'config' || name === 'configEmbedded'
          ? modes.flatMap((mode) => (typeof mode === 'string' ? envCandidates(root, mode) : []))
          : [],
      );
      const reads = traceReads(
        [
          ...done.trace.reads.map((read) =>
            read.kind === 'resolve' ? { ...read, kind: 'dir' as const } : { ...read, kind: read.kind },
          ),
          ...done.trace.modules.map((module) => ({ ...module, kind: 'module' as const })),
          ...[...candidates].map((path): { path: string; kind: ReadKind } => ({
            path,
            kind: existsSync(path) ? 'file' : 'absent',
          })),
        ].filter(({ path }) => !within(path, SHIMS)),
        roots,
        since,
        session.stamped,
        packageRoot,
        (dir) => owner(join(dir, 'package.json')) !== null,
        session.reals,
        content,
      );
      const names = [...new Set([...done.trace.env, ...STARTUP_ENV])];
      if (done.trace.enumerators.length > 0) names.push('*');
      if (reads) {
        const recorded: PartRecord = {
          startedAtNs: String(since),
          env: names.map((envName) => [envName, digest(envName)]),
          envNames: done.trace.env,
          reads,
          output,
          wrapped,
          derived,
        };
        keep = () => session.keep(variant, recorded);
      }
    }
    return { name, output, wrapped, envNames: done.trace.env, derived, env: partEnv, fromIndex: false, keep };
  };
  const spawn: typeof spawnOne = (...args) => {
    const pending = spawnOne(...args);
    running.push(pending);
    void pending.catch(() => {});
    return pending;
  };
  const parts: Promise<Part | EvalUncertain>[] = [];
  const rows: Input[] = [];
  const embedded = embedEnv(opts.env);
  const embedLoader = (constants: string) => {
    const script = join(constants, 'scripts', 'getAppConfig.js');
    return existsSync(script) && readFileSync(script, 'utf8').includes('loadProjectEnv') ? opts.embedMode : 'env';
  };
  const embed = (constants: string, signal?: AbortSignal) =>
    spawn(
      'configEmbedded',
      [evaluator, 'embed', root, platform, embedLoader(constants), constants],
      embedded,
      `configEmbedded:${embedLoader(constants)}`,
      signal,
    );
  let early: { constants: string; part: Promise<Part | EvalUncertain> } | null = null;
  if (expo) {
    rows.push(...envRows('env:', ['EXPO_USE_COMMUNITY_AUTOLINKING'], env, true, form));
    const autolinking = findPackage(expo, 'expo-modules-autolinking') ?? findPackage(root, 'expo-modules-autolinking');
    const manifest = autolinking ? record(JSON.parse(readFileSync(join(autolinking, 'package.json'), 'utf8'))) : {};
    if (!autolinking || !versionAtLeast(manifest.version, 1, 12))
      return { uncertain: 'expo-modules-autolinking 1.12.0 or later is required', remedy: 'npx expo install --fix' };
    const bin = join(
      autolinking,
      String(record(manifest.bin)['expo-modules-autolinking'] ?? 'bin/expo-modules-autolinking.js'),
    );
    const setup = native === 'tracked' ? trackedAutolinking(nativeDir, platform) : 'expo';
    if (!setup)
      return {
        uncertain: `stim does not recognise the autolinking command in ${nativeDir}`,
        remedy: 'Use the Podfile or settings.gradle of the Expo template.',
      };
    parts.push(spawn('config', [evaluator, 'expo', root, platform]));
    parts.push(spawn('expoAutolinking', [bin, 'resolve', '-p', platform === 'ios' ? 'apple' : 'android', '--json']));
    parts.push(
      setup === 'bare' || env.EXPO_USE_COMMUNITY_AUTOLINKING === '1'
        ? spawn('rnConfig', [evaluator, 'rn', root, platform])
        : spawn('rnConfig', [bin, 'react-native-config', '--json', '--platform', platform]),
    );
    const constants = findPackage(root, 'expo-constants');
    if (constants && embedLoader(constants) === 'env') {
      early = { constants, part: embed(constants, opts.signal ? AbortSignal.any([opts.signal, settled]) : settled) };
      early.part.catch(() => {});
    }
  } else parts.push(spawn('rnConfig', [evaluator, 'rn', root, platform]));
  const { names: buildNames, scanned, scan, settle } = buildEnvNames(root, native, nativeDir, expo, session);
  const closure = session ? session.closure(() => entryPoints(root, expo)) : entryPoints(root, expo);
  const linkedPackages = (part: Part): string[] => {
    const output = record(part.wrapped ? record(part.output).config : part.output);
    const paths =
      part.name === 'expoAutolinking'
        ? pathStrings(part.output)
        : part.name === 'rnConfig'
          ? Object.values(record(output.dependencies)).map((dependency) => record(dependency).root)
          : [];
    return paths.flatMap((path) => (typeof path === 'string' && packageRoot(path)) || []);
  };
  const done = await Promise.all(
    parts.map((pending) =>
      pending.then((part) => {
        if (!isUncertain(part)) scan([...part.derived.packages, ...linkedPackages(part)]);
        return part;
      }),
    ),
  );
  const failure = done.find(isUncertain);
  if (failure) return failure;
  const evaluated = done.filter((part): part is Part => !isUncertain(part));
  evaluated.forEach((part) => part.keep());
  const byName = new Map(evaluated.map((part) => [part.name, part]));

  const autolinked = new Set<string>();
  const nativePackages = new Set<string>();
  const resolved = byName.get('expoAutolinking');
  if (resolved) {
    const modules = record(resolved.output).modules;
    const names = Array.isArray(modules) ? modules.map((module) => record(module).packageName) : [];
    if (!names.includes('expo'))
      return failed('expoAutolinking', 'listed no expo module, so it did not run in an Expo project');
    names.forEach((name) => typeof name === 'string' && nativePackages.add(name));
    rows.push({ name: 'autolinking:expo', kind: 'autolinking', hash: resolved.derived.autolinking ?? '' });
  }
  const rn = byName.get('rnConfig');
  const rnOutput = record(rn?.wrapped ? record(rn.output).config : rn?.output);
  if (typeof rnOutput.dependencies !== 'object' || rnOutput.dependencies === null || !rn?.derived.autolinking)
    return failed('rnConfig', `has no dependencies for ${platform}`);
  const namedNativePaths: Record<string, string[]> = {};
  for (const [name, dependency] of Object.entries(record(rnOutput.dependencies))) {
    const entry = record(dependency);
    if (typeof entry.root === 'string') {
      const dependencyRoot = entry.root;
      autolinked.add(dependencyRoot);
      const platforms = record(entry.platforms);
      const names = rnNativePaths(dependencyRoot, platforms);
      (namedNativePaths[dependencyRoot] ??= []).push(...names);
      const actualRoot = realOr(dependencyRoot);
      if (actualRoot !== dependencyRoot) (namedNativePaths[actualRoot] ??= []).push(...names);
    }
    nativePackages.add(name);
  }
  rows.push({ name: 'autolinking:rn', kind: 'autolinking', hash: rn.derived.autolinking });
  for (const path of pathStrings(resolved?.output)) autolinked.add(path);

  const linkedOwners = autolinkedPackages(autolinked, roots);
  if ('uncertain' in linkedOwners) return linkedOwners;
  const { packages, contentPackages } = linkedOwners;
  addExpoNamedPaths(resolved?.output, [...packages, ...contentPackages], namedNativePaths);

  const config = byName.get('config');
  const output = record(config?.output ?? (rn?.wrapped ? rn.output : null));
  const configModules: string[] = [];
  const opaque: string[] = [];
  const collect = (part: Part, prefix: string, pin: boolean) => {
    rows.push(...envRows(prefix, part.envNames, part.env, pin, form), ...part.derived.rows);
    if (part.derived.enumerated) rows.push({ ...enumerationRow(part.env, form, pin), name: `${prefix}*` });
    part.derived.packages.forEach((dir) => packages.add(dir));
    if (part.name === 'config' || part.name === 'configEmbedded') configModules.push(...part.derived.modules);
    opaque.push(...part.derived.opaque);
  };
  for (const part of evaluated) collect(part, 'env:', true);
  if (config) {
    const mode = String(output.mode);
    rows.push(
      configRow('config', output.config, roots),
      ...envCandidates(root, mode).map((path) => fileRow(path, roots, session)),
    );
    if (nativePackages.has('expo-updates'))
      rows.push({ name: 'runtimeVersion', kind: 'config', hash: sha256(canonicalJson(output.runtimeVersion ?? null)) });
    if (nativePackages.has('expo-constants')) {
      const embeddedName: PartName = 'configEmbedded';
      const linkedModules = record(resolved?.output).modules;
      const linked: unknown[] = Array.isArray(linkedModules) ? linkedModules : [];
      const constants =
        pathStrings(linked.find((module) => record(module).packageName === 'expo-constants'))
          .map(installedPackage)
          .find((dir) => dir !== null) ?? findPackage(root, 'expo-constants');
      if (!constants) return failed('configEmbedded', 'found no expo-constants package to read its loader from');
      const byMode = embedLoader(constants) !== 'env';
      const reuse =
        byMode &&
        opts.embedMode === mode &&
        !config.derived.enumerated &&
        config.envNames.every((name) => isDenied(name) || env[name] === embedded[name]);
      const part = reuse
        ? { ...config, name: embeddedName, env: embedded }
        : await (early?.constants === constants ? early.part : embed(constants));
      if (isUncertain(part)) return part;
      const privateNames = Object.keys(embedded).filter(privateReplayEnv);
      if (
        privateNames.some((name) => part.envNames.includes(name)) ||
        (privateNames.length > 0 && part.derived.enumerated)
      )
        return {
          uncertain: 'embedded project configuration reads a private Stim credential that cannot be replayed safely',
          evaluator: 'configEmbedded' as const,
          remedy: 'Remove the private Stim credential from the build environment and retry.',
        };
      if (!reuse) part.keep();
      if (reuse) rows.push(...envRows('env@embed:', config.envNames, embedded, false, form));
      else {
        evaluated.push(part);
        collect(part, 'env@embed:', false);
      }
      const envFiles = byMode
        ? envCandidates(root, opts.embedMode)
        : embedded.NODE_ENV
          ? envCandidates(root, embedded.NODE_ENV)
          : ['.env.local', '.env'].map((name) => join(root, name));
      rows.push(...envFiles.map((path) => fileRow(path, roots, session)));
      rows.push(configRow('config@embed', record(part.output).config, roots));
    }
  }

  scan([...packages, ...contentPackages]);
  await settle();
  let buildEnv = buildEnvRows(buildNames, opts.env, platform, form);
  for (let owned = buildEnv.paths.map(installedPackage); owned.some((dir) => dir && !scanned.has(dir));) {
    owned.forEach((dir) => dir && packages.add(dir));
    scan(owned.filter((dir): dir is string => Boolean(dir)));
    await settle();
    buildEnv = buildEnvRows(buildNames, opts.env, platform, form);
    owned = buildEnv.paths.map(installedPackage);
  }
  const { _internal: _, ...configValues } = record(output.config);
  const configFiles = strings(configValues).flatMap((value) => {
    if (!value || value.length >= 1024 || /[\0\n]/.test(value)) return [];
    try {
      const real = realpathSync.native(resolve(root, value));
      const dir = installedPackage(real);
      if (dir) packages.add(dir);
      if (dir || within(real, roots.project) || within(real, roots.install)) return [];
      if (statSync(real).isFile()) return [real];
      if (/^\.\.?(?:[\\/]|$)/.test(value) || (within(real, homedir()) && real !== homedir())) outsideValue = true;
      return [];
    } catch {
      return [];
    }
  });
  let pathRows: ReturnType<typeof walk>;
  try {
    pathRows = walk({
      roots,
      trees: [...buildEnv.paths.filter((path) => !installedPackage(path)), ...configFiles],
      tracked: null,
      hashes: session?.hashes,
    });
  } catch (error) {
    return { uncertain: `stim cannot read a file the build env or config names: ${String(error)}` };
  }
  if (isUncertain(pathRows)) return pathRows;
  const closureIdentities = packageIdentities(closure.dirs, roots, session, classify, namedNativePaths);
  if (isUncertain(closureIdentities)) return closureIdentities;
  const closureDirs = new Set(closure.dirs);
  const identities = packageIdentities(
    [...packages].filter((dir) => !closureDirs.has(dir)),
    roots,
    session,
    classify,
    namedNativePaths,
  );
  if (isUncertain(identities)) return identities;
  rows.push(
    ...buildEnv.rows,
    ...pathRows.inputs,
    ...packageRows([...closureIdentities, ...identities], closure.missing),
  );
  const { home, username } = { home: homedir(), username: userInfo().username };
  const configText = keyedConfig(output.config, roots);
  return {
    rows,
    config: output.config ? record(output.config) : null,
    fingerprintConfig: output.fingerprintConfig,
    contentPackages: [...contentPackages],
    namedNativePaths,
    nativePackages: [...nativePackages].toSorted(byCodeUnit),
    configModules: [...new Set(configModules)].toSorted(byCodeUnit),
    opaque,
    fromIndex: evaluated.some((part) => part.fromIndex),
    portable:
      pathRows.portable &&
      evaluated.every((part) => part.derived.portable) &&
      !outsideValue &&
      !configText.includes(home) &&
      !(username.length > 2 && configText.includes(username)),
  };
}

/**
 * Stim's build-cache key for a platform: the static rows, the evaluated app config and autolinking, and the env the
 * native build reads. Any evaluator failure is `Uncertain`, never a key with fewer inputs. With the index, a part
 * whose recorded env, stamps and reads all still hold is reused instead of re-run.
 */
let delegatedOwnership = false;
let parentTemporaryRoot: string | null = null;

export function useParentFingerprintOwnership(temporaryRoot?: string): void {
  delegatedOwnership = true;
  parentTemporaryRoot = temporaryRoot ?? null;
}

export async function fingerprint(
  root: string,
  target: StaticTarget,
  opts: FingerprintOptions,
): Promise<Fingerprint | EvalUncertain> {
  const signal = opts.operation
    ? opts.signal
      ? AbortSignal.any([opts.operation.signal, opts.signal])
      : opts.operation.signal
    : opts.signal;
  if (delegatedOwnership) return fingerprintOwned(root, target, { ...opts, signal });
  let operation = opts.operation;
  if (!operation) {
    const context = processContext(root, signal);
    operation = {
      ...context,
      home: opts.env.STIM_HOME && isAbsolute(opts.env.STIM_HOME) ? opts.env.STIM_HOME : context.home,
      env: opts.env,
    };
  }
  return withFingerprintOwnership(
    operation,
    root,
    () => fingerprintOwned(root, target, { ...opts, operation, signal }),
    signal,
  );
}

async function fingerprintOwned(
  root: string,
  target: StaticTarget,
  opts: FingerprintOptions,
): Promise<Fingerprint | EvalUncertain> {
  const since = startedAt();
  const project = realpathSync.native(root);
  const roots: Roots = {
    project,
    install: installRoot(project),
    ...(opts.replay ? {} : { top: gitLocation(project)?.top }),
  };
  const session =
    opts.replay || opts.index === 'skip' || !existsSync(join(SHIMS, 'fp-trace.cjs'))
      ? null
      : new IndexSession(
          indexDir(target.platform, project, targetLayout(target), opts.operation?.home),
          roots,
          { evaluator: evaluatorKey(), runtime: projectNodeBin(project, opts.env)?.version ?? process.version },
          since,
          opts.index !== 'refresh',
          opts.operation?.home,
        );
  const tracked = opts.replay ? null : await trackedPaths(project, opts.signal, opts.operation);
  const expoResolves = findPackage(project, 'expo') !== null;
  const nativeDir = nativeDirectory(project, target);
  const native = opts.replay?.native ?? nativeMode({ expoResolves, tracked }, nativeDir);
  if (isUncertain(native)) return native;
  const settled = new AbortController();
  const running: Promise<unknown>[] = [];
  const evaluated = await evaluate(
    roots,
    target.platform,
    native,
    nativeDir,
    opts,
    session,
    settled.signal,
    running,
  ).finally(async () => {
    settled.abort();
    const outcomes = await Promise.allSettled(running);
    const failure = outcomes.find(
      (outcome) =>
        outcome.status === 'rejected' &&
        typeof outcome.reason === 'object' &&
        outcome.reason !== null &&
        'reportCleanup' in outcome.reason,
    );
    if (failure?.status === 'rejected') throw failure.reason;
  });
  if ('uncertain' in evaluated) return evaluated;
  const files = opts.replay ? replayFiles(opts.replay.sources, roots, target) : null;
  if (files && isUncertain(files)) return files;
  const override = opts.replay?.sources.find((source) => source.id === 'stim:fingerprintInputs');
  if (override && override.kind !== 'manifest') return { uncertain: 'invalid fingerprint input override' };
  const statics = staticInputs(
    {
      root: project,
      ...(files && opts.replay
        ? {
            replay: {
              native,
              files,
              verifyMembership: opts.replay.allowChanges === true,
              ...(override
                ? { fingerprintInputs: { name: override.id, kind: override.kind, hash: override.hash } }
                : {}),
            },
          }
        : {}),
      tracked,
      expoResolves,
      config: expoResolves ? evaluated.config : null,
      fingerprintConfig: evaluated.fingerprintConfig,
      contentPackages: evaluated.contentPackages,
      namedNativePaths: evaluated.namedNativePaths,
      hashes: session?.hashes,
    },
    target,
  );
  if (isUncertain(statics)) return statics;
  let inputs: Input[];
  try {
    inputs = mergeInputs([...statics.inputs, ...evaluated.rows]);
  } catch (error) {
    return { uncertain: error instanceof Error ? error.message : String(error) };
  }
  if (opts.replay && !opts.replay.allowChanges) {
    const expected = opts.replay.sources.map((source) => [source.id, source.kind, source.hash]);
    const actual = inputs.map((input) => [input.name, input.kind, input.hash]);
    if (canonicalJson(expected.toSorted(([a], [b]) => byCodeUnit(a ?? '', b ?? ''))) !== canonicalJson(actual))
      return { uncertain: 'the worker fingerprint inputs differ from the client' };
  }
  if (session) {
    session.save();
    writeWorkspaceEnv(project, workspaceEnv(opts.env), opts.operation?.home);
  }
  const folded = new Set<string>();
  const caseCollision = inputs.some((input) => {
    const name = input.name.toLowerCase();
    if (folded.has(name)) return true;
    folded.add(name);
    return false;
  });
  const portable =
    statics.portable &&
    evaluated.portable &&
    !caseCollision &&
    !inputs.some((input) => input.name.startsWith('outside:'));
  return {
    schema: FINGERPRINT_SCHEMA,
    hash: preimageHash(preimage(target.platform, statics.native, statics.layout, inputs)),
    platform: target.platform,
    native: statics.native,
    inputs,
    nativePackages: evaluated.nativePackages,
    configModules: evaluated.configModules,
    config: evaluated.config,
    portable,
    opaque: evaluated.opaque,
    from: evaluated.fromIndex ? 'index' : 'evaluated',
    fingerprintConfigKeys: strings(record(evaluated.fingerprintConfig).keys),
  };
}
