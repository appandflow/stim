import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNodeBin } from '@stim-cli/core/toolchain';
import { getExecutor } from '../exec.ts';
import { entryPoints, findPackage, installedPackage, packageIdentity, packageRoot, packageRows } from './closure.ts';
import {
  buildEnvRows,
  buildScripts,
  embedEnv,
  enumerationRow,
  envRows,
  evaluatorEnv,
  isDenied,
  workspaceEnv,
  scriptEnvNames,
  templateScripts,
} from './env.ts';
import { trackedPaths } from './git-index.ts';
import {
  IndexSession,
  indexDir,
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
  /** `skip` computes every part and writes no index record, as verification does. Default `use`. */
  index?: 'use' | 'skip';
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
  reads: { path: string; kind: ReadKind; hash?: string }[];
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
}

/** Env names Node reads at startup, before the trace exists; a part is reused only while they hold. */
const STARTUP_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_PRESERVE_SYMLINKS', 'NODE_ICU_DATA'];

const TIMEOUT_MS = 60_000;
const ABSENT = sha256(canonicalJson(['absent']));
const SCRIPT = /\.(?:[cm]?js|[cm]?ts)$/;
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

function run(
  part: PartName,
  node: string,
  args: string[],
  root: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  return new Promise<{ result: string; stdout: string; trace: Trace } | EvalUncertain>((resolved) => {
    if (signal?.aborted) return resolved(failed(part, 'was cancelled'));
    const started = Date.now();
    let settled = false;
    const done = (value: { result: string; stdout: string; trace: Trace } | EvalUncertain) => {
      if (!settled) resolved(value);
      settled = true;
    };
    const child = getExecutor().spawn(node, ['--require', join(SHIMS, 'fp-trace.cjs'), ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[][] = [[], [], [], [], []];
    child.stdio.forEach((stream, fd) => stream?.on('data', (chunk: Buffer) => chunks[fd]?.push(chunk)));
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      stop();
      finish('timed out');
    }, TIMEOUT_MS);
    signal?.addEventListener('abort', stop, { once: true });
    const text = (fd: number) => Buffer.concat(chunks[fd] ?? []).toString('utf8');
    const finish = (why: string | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (why === null) {
        let trace: unknown = null;
        try {
          trace = JSON.parse(text(4));
        } catch {}
        if (isTrace(trace)) return done({ result: text(3), stdout: text(1), trace });
        why = 'wrote no readable trace';
      }
      done({
        ...failed(part, `${why} after ${Date.now() - started} ms`),
        stderrTail: text(2)
          .trimEnd()
          .split('\n')
          .filter((line) => !/^\s+at /.test(line))
          .slice(-20),
      });
    };
    child.on('error', (error) => finish(`could not start: ${error.message}`));
    child.on('close', (code, killed) =>
      finish(code === 0 ? null : killed ? `was stopped by ${killed}` : `exited ${code}`),
    );
  });
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
): Uncertain | Omit<Derived, 'autolinking'> {
  const rows: Input[] = [];
  const inApp = (path: string) =>
    (within(path, roots.project) || within(path, roots.install)) && !path.split(sep).includes('node_modules');
  const packages = new Set<string>();
  const modules: string[] = [];
  const ours = (path: string) => within(path, SHIMS) || excluded.some((dir) => within(path, dir));
  for (const { path, hash } of trace.modules) {
    if (ours(path) || SKIPPED_READS.has(basename(path))) continue;
    const dir = owner(path);
    if (dir) packages.add(dir);
    else if (existsSync(path)) {
      const row = fileRow(path, roots);
      modules.push(row.name);
      rows.push(row);
    } else rows.push({ name: `virtual:${pathForm(path, roots)}`, kind: 'file', hash });
  }
  const compiled = new Set(trace.modules.map((module) => module.path));
  for (const { path, kind, hash } of trace.reads) {
    if (ours(path) || packageRoot(path)) continue;
    if (kind !== 'file') {
      if (inApp(path) && (name === 'config' || name === 'configEmbedded'))
        rows.push(
          kind === 'dir'
            ? { name: `dir:${realForm(path, roots)}`, kind: 'file', hash: hash ?? ABSENT }
            : { name: `exists:${realForm(path, roots)}`, kind: 'file', hash: sha256(kind) },
        );
      continue;
    }
    if (SKIPPED_READS.has(basename(path))) continue;
    if (
      trace.opaque.includes('module.registerHooks missing') &&
      SCRIPT.test(path) &&
      inApp(path) &&
      !compiled.has(path)
    )
      return { uncertain: `${path} was read as a module this Node cannot capture; use Node 22.15 or later` };
    rows.push(fileRow(path, roots));
  }
  return {
    rows,
    packages: [...packages],
    modules,
    opaque: trace.opaque.map((call) => `${name}: ${call}`),
    enumerated: trace.enumerators.some(inApp),
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

/** The env digest a part is checked against: a value's hash in its relocated form, or the enumeration's. */
function envDigest(env: Record<string, string>, roots: Roots): (name: string) => string | null {
  return (name) => {
    if (name === '*') return enumerationRow(env).hash;
    const value = env[name];
    return value === undefined ? null : sha256(isAbsolute(value) ? relocate(resolve(value), roots) : value);
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

const scriptNames = (paths: string[]) => paths.flatMap((path) => scriptEnvNames(readFileSync(path, 'utf8')));

/**
 * The env names the native build scripts read: the tracked native directory's or the prebuild template's, React
 * Native's, autolinking's and the Gradle plugin's, and every package `scan` adds. An installed package's names are
 * kept in the index under its `package.json`.
 */
function buildEnvNames(
  root: string,
  native: NativeMode,
  nativeDir: string,
  expo: string | null,
  session: IndexSession | null,
): { names: string[]; scanned: Set<string>; scan: (dirs: Iterable<string>) => void } {
  const reactNative = findPackage(root, 'react-native');
  const scanned = new Set<string>();
  const names: string[] = [];
  if (native === 'tracked') names.push(...scriptNames(buildScripts(nativeDir)));
  if (native === 'generated' && expo && existsSync(join(expo, 'template.tgz'))) {
    const entry = session?.pkg(expo);
    const template = entry?.template ?? templateScripts(join(expo, 'template.tgz')).flatMap(scriptEnvNames);
    if (entry) entry.template = template;
    names.push(...template);
  }
  const scan = (dirs: Iterable<string>) => {
    for (const dir of dirs) {
      if (scanned.has(dir)) continue;
      scanned.add(dir);
      const entry = installedPackage(dir) ? session?.pkg(dir) : undefined;
      const found = entry?.scan ?? scriptNames(buildScripts(dir));
      if (entry) entry.scan = found;
      names.push(...found);
    }
  };
  scan(
    [
      reactNative,
      expo && findPackage(expo, 'expo-modules-autolinking'),
      reactNative && findPackage(reactNative, '@react-native/gradle-plugin'),
    ].filter((dir): dir is string => Boolean(dir)),
  );
  return { names, scanned, scan };
}

/**
 * The identity and provenance of each package a part loaded or the entry points name. A copy the lockfile does not
 * show as a registry tarball is identified by the digest of its native files instead.
 */
function packageIdentities(
  dirs: Iterable<string>,
  roots: Roots,
  session: IndexSession | null,
): Uncertain | { name: string; version: string; provenance: Provenance; content?: string }[] {
  let lockfile: Classifier | null = null;
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
    entry.provenance ??= (lockfile ??= lockfileClassifier(roots.install).classify)(realOr(dir), identity);
    if (entry.provenance.mode === 'identity') {
      identities.push({ ...identity, provenance: entry.provenance });
      continue;
    }
    const walked = walk({ roots, trees: nativeSubset(dir), tracked: null, hashes: session?.hashes });
    if (isUncertain(walked)) return walked;
    const content = sha256(canonicalJson(walked.inputs.map((input) => [input.name, input.hash])));
    identities.push({ ...identity, provenance: entry.provenance, content });
  }
  return identities;
}

async function evaluate(
  roots: Roots,
  platform: Platform,
  native: NativeMode,
  nativeDir: string,
  opts: FingerprintOptions,
  session: IndexSession | null,
) {
  const root = roots.project;
  let outsideValue = false;
  const form = (path: string) => {
    const keyed = realForm(path, roots);
    if (keyed.startsWith('outside:')) outsideValue = true;
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
  const spawn = async (
    name: PartName,
    args: string[],
    partEnv = env,
    slot: string = name,
  ): Promise<Part | EvalUncertain> => {
    const wrapped = args[0] === evaluator;
    const digest = envDigest(partEnv, roots);
    const cached = session?.part(slot, digest);
    if (cached)
      return {
        name,
        output: cached.output,
        wrapped,
        envNames: cached.envNames,
        derived: cached.derived,
        env: partEnv,
        fromIndex: true,
      };
    const since = session?.since ?? 0n;
    const done = await run(name, node, args, root, partEnv, opts.signal);
    if (isUncertain(done)) return done;
    const output = parse(name, wrapped ? done.result : done.stdout);
    if (isUncertain(output)) return output;
    const traced = traceRows(name, done.trace, roots, excluded, owner);
    if (isUncertain(traced)) return traced;
    const derived: Derived = { ...traced, autolinking: autolinkingHash(name, output, wrapped, roots) };
    if (session && done.trace.opaque.length === 0) {
      const modes = [record(output).mode, partEnv.NODE_ENV, 'development', 'production'];
      const candidates = new Set(
        name === 'config' || name === 'configEmbedded'
          ? modes.flatMap((mode) => (typeof mode === 'string' ? envCandidates(root, mode) : []))
          : [],
      );
      const reads = traceReads(
        [
          ...done.trace.reads,
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
      );
      const names = [...new Set([...done.trace.env, ...STARTUP_ENV])];
      if (derived.enumerated) names.push('*');
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
        session.keep(slot, recorded);
      }
    }
    return { name, output, wrapped, envNames: done.trace.env, derived, env: partEnv, fromIndex: false };
  };
  const parts: Promise<Part | EvalUncertain>[] = [];
  const rows: Input[] = [];
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
  } else parts.push(spawn('rnConfig', [evaluator, 'rn', root, platform]));
  const done = await Promise.all(parts);
  const failure = done.find(isUncertain);
  if (failure) return failure;
  const evaluated = done.filter((part): part is Part => !isUncertain(part));
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
  for (const [name, dependency] of Object.entries(record(rnOutput.dependencies))) {
    if (typeof record(dependency).root === 'string') autolinked.add(String(record(dependency).root));
    nativePackages.add(name);
  }
  rows.push({ name: 'autolinking:rn', kind: 'autolinking', hash: rn.derived.autolinking });
  for (const path of pathStrings(resolved?.output)) autolinked.add(path);

  const contentPackages = new Set<string>();
  const packages = new Set<string>();
  for (const path of autolinked) {
    const dir = packageRoot(path);
    if (dir) {
      packages.add(dir);
      continue;
    }
    let dir2 = path;
    while (dir2 !== root && dir2 !== roots.install && dirname(dir2) !== dir2 && !existsSync(join(dir2, 'package.json')))
      dir2 = dirname(dir2);
    if (existsSync(join(dir2, 'package.json')) && dir2 !== root && dir2 !== roots.install) contentPackages.add(dir2);
    else if (!within(path, roots.project) && !within(path, roots.install))
      return { uncertain: `autolinking names ${path}, which belongs to no package stim can hash` };
  }

  const config = byName.get('config');
  const output = record(config?.output ?? (rn?.wrapped ? rn.output : null));
  const configModules: string[] = [];
  const opaque: string[] = [];
  const collect = (part: Part, prefix: string, pin: boolean) => {
    rows.push(...envRows(prefix, part.envNames, part.env, pin, form), ...part.derived.rows);
    if (part.derived.enumerated) rows.push({ ...enumerationRow(part.env), name: `${prefix}*` });
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
      const embedded = embedEnv(opts.env);
      const linkedModules = record(resolved?.output).modules;
      const linked: unknown[] = Array.isArray(linkedModules) ? linkedModules : [];
      const constants =
        pathStrings(linked.find((module) => record(module).packageName === 'expo-constants'))
          .map(installedPackage)
          .find((dir) => dir !== null) ?? findPackage(root, 'expo-constants');
      if (!constants) return failed('configEmbedded', 'found no expo-constants package to read its loader from');
      const script = join(constants, 'scripts', 'getAppConfig.js');
      const byMode = existsSync(script) && readFileSync(script, 'utf8').includes('loadProjectEnv');
      const reuse =
        byMode &&
        opts.embedMode === mode &&
        config.envNames.every((name) => isDenied(name) || env[name] === embedded[name]);
      const embedMode = byMode ? opts.embedMode : 'env';
      const part = reuse
        ? { ...config, name: embeddedName, env: embedded }
        : await spawn(
            'configEmbedded',
            [evaluator, 'embed', root, platform, embedMode, constants],
            embedded,
            `configEmbedded:${embedMode}`,
          );
      if (isUncertain(part)) return part;
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

  const { names, scanned, scan } = buildEnvNames(root, native, nativeDir, expo, session);
  scan([...packages, ...contentPackages]);
  let buildEnv = buildEnvRows(names, opts.env, platform, form);
  for (let owned = buildEnv.paths.map(installedPackage); owned.some((dir) => dir && !scanned.has(dir));) {
    owned.forEach((dir) => dir && packages.add(dir));
    scan(owned.filter((dir): dir is string => Boolean(dir)));
    buildEnv = buildEnvRows(names, opts.env, platform, form);
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
  const closure = session ? session.closure(() => entryPoints(root, expo)) : entryPoints(root, expo);
  const identities = packageIdentities([...packages, ...closure.dirs], roots, session);
  if (isUncertain(identities)) return identities;
  rows.push(...buildEnv.rows, ...pathRows.inputs, ...packageRows(identities, closure.missing));
  const { home, username } = { home: homedir(), username: userInfo().username };
  const configText = keyedConfig(output.config, roots);
  return {
    rows,
    config: output.config ? record(output.config) : null,
    fingerprintConfig: output.fingerprintConfig,
    contentPackages: [...contentPackages],
    nativePackages: [...nativePackages].toSorted(byCodeUnit),
    configModules: [...new Set(configModules)].toSorted(byCodeUnit),
    opaque,
    fromIndex: evaluated.some((part) => part.fromIndex),
    portable:
      pathRows.portable &&
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
export async function fingerprint(
  root: string,
  target: StaticTarget,
  opts: FingerprintOptions,
): Promise<Fingerprint | EvalUncertain> {
  const since = startedAt();
  const project = realpathSync.native(root);
  const roots: Roots = { project, install: installRoot(project) };
  const session =
    opts.index === 'skip' || !existsSync(join(SHIMS, 'fp-trace.cjs'))
      ? null
      : new IndexSession(
          indexDir(target.platform, project, targetLayout(target)),
          roots,
          { evaluator: evaluatorKey(), runtime: projectNodeBin(project, opts.env)?.version ?? process.version },
          since,
        );
  const tracked = await trackedPaths(project, opts.signal);
  const expoResolves = findPackage(project, 'expo') !== null;
  const nativeDir = nativeDirectory(project, target);
  const native = nativeMode({ expoResolves, tracked }, nativeDir);
  if (isUncertain(native)) return native;
  const evaluated = await evaluate(roots, target.platform, native, nativeDir, opts, session);
  if (isUncertain(evaluated)) return evaluated;
  const statics = staticInputs(
    {
      root: project,
      tracked,
      expoResolves,
      config: evaluated.config,
      fingerprintConfig: evaluated.fingerprintConfig,
      contentPackages: evaluated.contentPackages,
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
  if (session) {
    session.save();
    writeWorkspaceEnv(project, workspaceEnv(opts.env));
  }
  const portable = statics.portable && evaluated.portable && !inputs.some((input) => input.name.startsWith('outside:'));
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
