import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNodeBin } from '@stim-cli/core/toolchain';
import { getExecutor } from '../exec.ts';
import { entryPoints, findPackage, installedPackage, packageRoot, packageRows } from './closure.ts';
import {
  buildEnvRows,
  buildScripts,
  embedEnv,
  enumerationRow,
  envRows,
  evaluatorEnv,
  isDenied,
  templateScripts,
} from './env.ts';
import { trackedPaths } from './git-index.ts';
import { installRoot, nativeDirectory, nativeMode, staticInputs, type StaticTarget } from './inputs.ts';
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
import { pathForm, walk, within, type Roots } from './walk.ts';

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
}
interface Trace {
  env: string[];
  enumerators: string[];
  reads: { path: string; kind: string; hash?: string }[];
  modules: { path: string; hash: string }[];
  opaque: string[];
}
interface Part {
  name: PartName;
  output: unknown;
  /** Whether fp-eval.cjs produced the output, which then wraps what it evaluated. */
  wrapped: boolean;
  trace: Trace;
  env: Record<string, string>;
}

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

function fileRow(path: string, roots: Roots): Input {
  let real = path;
  let hash = ABSENT;
  try {
    real = realpathSync.native(path);
    hash = sha256(readFileSync(real));
  } catch {}
  return { name: pathForm(real, roots), kind: 'file', hash };
}

const envCandidates = (root: string, mode: string) =>
  [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'].map((name) => join(root, name));

/** Rows for what one part read: env names, files and modules inside the app, and the packages it loaded code from. */
function traceRows(
  part: Part,
  roots: Roots,
  excluded: readonly string[],
  prefix: string,
  pinned: boolean,
  form: (path: string) => string,
): Uncertain | { rows: Input[]; packages: string[]; modules: string[]; opaque: string[] } {
  const { trace } = part;
  const rows = envRows(prefix, trace.env, part.env, pinned, form);
  const inApp = (path: string) =>
    (within(path, roots.project) || within(path, roots.install)) && !path.split(sep).includes('node_modules');
  if (trace.enumerators.some(inApp)) rows.push({ ...enumerationRow(part.env), name: `${prefix}*` });
  const packages: string[] = [];
  const modules: string[] = [];
  const ours = (path: string) => within(path, SHIMS) || excluded.some((dir) => within(path, dir));
  for (const { path, hash } of trace.modules) {
    if (ours(path) || SKIPPED_READS.has(basename(path))) continue;
    const owner = installedPackage(path);
    if (owner) packages.push(owner);
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
      if (inApp(path) && (part.name === 'config' || part.name === 'configEmbedded'))
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
  return { rows, packages, modules, opaque: trace.opaque.map((call) => `${part.name}: ${call}`) };
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

async function evaluate(
  roots: Roots,
  platform: Platform,
  native: NativeMode,
  nativeDir: string,
  opts: FingerprintOptions,
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
  const spawn = async (name: PartName, args: string[], partEnv = env): Promise<Part | EvalUncertain> => {
    const done = await run(name, node, args, root, partEnv, opts.signal);
    if (isUncertain(done)) return done;
    const wrapped = args[0] === evaluator;
    const output = parse(name, wrapped ? done.result : done.stdout);
    return isUncertain(output) ? output : { name, output, wrapped, trace: done.trace, env: partEnv };
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
    rows.push({
      name: 'autolinking:expo',
      kind: 'autolinking',
      hash: sha256(canonicalJson(normalize(resolved.output, roots, true))),
    });
  }
  const rn = byName.get('rnConfig');
  const rnOutput = record(rn?.wrapped ? record(rn.output).config : rn?.output);
  if (typeof rnOutput.dependencies !== 'object' || rnOutput.dependencies === null)
    return failed('rnConfig', `has no dependencies for ${platform}`);
  for (const [name, dependency] of Object.entries(record(rnOutput.dependencies))) {
    if (typeof record(dependency).root === 'string') autolinked.add(String(record(dependency).root));
    nativePackages.add(name);
  }
  rows.push({
    name: 'autolinking:rn',
    kind: 'autolinking',
    hash: sha256(canonicalJson(normalize(rnOutput.dependencies, roots, true))),
  });
  for (const path of pathStrings(resolved?.output)) autolinked.add(path);

  const contentPackages = new Set<string>();
  const packages = new Set<string>();
  for (const path of autolinked) {
    const owner = packageRoot(path);
    if (owner) {
      packages.add(owner);
      continue;
    }
    let dir = path;
    while (dir !== root && dir !== roots.install && dirname(dir) !== dir && !existsSync(join(dir, 'package.json')))
      dir = dirname(dir);
    if (existsSync(join(dir, 'package.json')) && dir !== root && dir !== roots.install) contentPackages.add(dir);
    else if (!within(path, roots.project) && !within(path, roots.install))
      return { uncertain: `autolinking names ${path}, which belongs to no package stim can hash` };
  }

  const config = byName.get('config');
  const output = record(config?.output ?? (rn?.wrapped ? rn.output : null));
  const excluded = [nativeDir, join(root, 'ios'), join(root, 'android')];
  const configModules: string[] = [];
  const opaque: string[] = [];
  const collect = (part: Part, prefix: string, pin: boolean): Uncertain | null => {
    const traced = traceRows(part, roots, excluded, prefix, pin, form);
    if (isUncertain(traced)) return traced;
    rows.push(...traced.rows);
    traced.packages.forEach((dir) => packages.add(dir));
    if (part.name === 'config' || part.name === 'configEmbedded') configModules.push(...traced.modules);
    opaque.push(...traced.opaque);
    return null;
  };
  for (const part of evaluated) {
    const problem = collect(part, 'env:', true);
    if (problem) return problem;
  }
  if (config) {
    const mode = String(output.mode);
    rows.push(
      configRow('config', output.config, roots),
      ...envCandidates(root, mode).map((path) => fileRow(path, roots)),
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
        config.trace.env.every((name) => isDenied(name) || env[name] === embedded[name]);
      const part = reuse
        ? { ...config, name: embeddedName, env: embedded }
        : await spawn(
            'configEmbedded',
            [evaluator, 'embed', root, platform, byMode ? opts.embedMode : 'env', constants],
            embedded,
          );
      if (isUncertain(part)) return part;
      const problem = reuse ? null : collect(part, 'env@embed:', false);
      if (problem) return problem;
      if (reuse) rows.push(...envRows('env@embed:', config.trace.env, embedded, false, form));
      const envFiles = byMode
        ? envCandidates(root, opts.embedMode)
        : embedded.NODE_ENV
          ? envCandidates(root, embedded.NODE_ENV)
          : ['.env.local', '.env'].map((name) => join(root, name));
      rows.push(...envFiles.map((path) => fileRow(path, roots)));
      rows.push(configRow('config@embed', record(part.output).config, roots));
    }
  }

  const reactNative = findPackage(root, 'react-native');
  const scanned = new Set<string>();
  const texts = native === 'tracked' ? buildScripts(nativeDir).map((path) => readFileSync(path, 'utf8')) : [];
  if (native === 'generated' && expo && existsSync(join(expo, 'template.tgz')))
    texts.push(...templateScripts(join(expo, 'template.tgz')));
  const scan = (dirs: Iterable<string>) => {
    for (const dir of dirs) {
      if (scanned.has(dir)) continue;
      scanned.add(dir);
      texts.push(...buildScripts(dir).map((path) => readFileSync(path, 'utf8')));
    }
  };
  scan([
    ...packages,
    ...contentPackages,
    ...[
      reactNative,
      expo && findPackage(expo, 'expo-modules-autolinking'),
      reactNative && findPackage(reactNative, '@react-native/gradle-plugin'),
    ].filter((dir): dir is string => Boolean(dir)),
  ]);
  let buildEnv = buildEnvRows(texts, opts.env, platform, form);
  for (let owners = buildEnv.paths.map(installedPackage); owners.some((dir) => dir && !scanned.has(dir));) {
    owners.forEach((dir) => dir && packages.add(dir));
    scan(owners.filter((dir): dir is string => Boolean(dir)));
    buildEnv = buildEnvRows(texts, opts.env, platform, form);
    owners = buildEnv.paths.map(installedPackage);
  }
  const { _internal: _, ...configValues } = record(output.config);
  const configFiles = strings(configValues).flatMap((value) => {
    if (!value || value.length >= 1024 || /[\0\n]/.test(value)) return [];
    try {
      const real = realpathSync.native(resolve(root, value));
      const owner = installedPackage(real);
      if (owner) packages.add(owner);
      if (owner || within(real, roots.project) || within(real, roots.install)) return [];
      if (statSync(real).isFile()) return [real];
      if (/^\.\.?[\\/]/.test(value)) outsideValue = true;
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
    });
  } catch (error) {
    return { uncertain: `stim cannot read a file the build env or config names: ${String(error)}` };
  }
  if (isUncertain(pathRows)) return pathRows;
  const closure = entryPoints(root, expo);
  rows.push(...buildEnv.rows, ...pathRows.inputs, ...packageRows([...packages, ...closure.dirs], closure.missing));
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
    portable:
      pathRows.portable &&
      !outsideValue &&
      !configText.includes(home) &&
      !(username.length > 2 && configText.includes(username)),
  };
}

/**
 * Stim's build-cache key for a platform: the static rows, the evaluated app config and autolinking, and the env the
 * native build reads. Any evaluator failure is `Uncertain`, never a key with fewer inputs.
 */
export async function fingerprint(
  root: string,
  target: StaticTarget,
  opts: FingerprintOptions,
): Promise<Fingerprint | EvalUncertain> {
  const project = realpathSync.native(root);
  const roots: Roots = { project, install: installRoot(project) };
  const tracked = await trackedPaths(project, opts.signal);
  const expoResolves = findPackage(project, 'expo') !== null;
  const nativeDir = nativeDirectory(project, target);
  const native = nativeMode({ expoResolves, tracked }, nativeDir);
  if (isUncertain(native)) return native;
  const evaluated = await evaluate(roots, target.platform, native, nativeDir, opts);
  if (isUncertain(evaluated)) return evaluated;
  const statics = staticInputs(
    {
      root: project,
      tracked,
      expoResolves,
      config: evaluated.config,
      fingerprintConfig: evaluated.fingerprintConfig,
      contentPackages: evaluated.contentPackages,
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
  };
}
