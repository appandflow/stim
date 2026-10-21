import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve, sep } from 'node:path';
import type { FingerprintSource } from '@expo/fingerprint';
import { normalizeOptionsAsync } from '@expo/fingerprint/build/Options.js';
import { isIgnoredPathWithMatchObjects } from '@expo/fingerprint/build/utils/Path.js';
import type { StimContext } from '@stim-cli/core';
import {
  FINGERPRINT_MEMO_SCHEMA,
  readFingerprintMemo,
  workspaceFingerprintMemoFile,
  workspaceFingerprintMemoLock,
  type FingerprintMemoRecord,
  type FingerprintMemoRow,
} from '@stim-cli/core/state';
import { shortHash } from '../command-output.ts';
import { debugLog } from '../debug-log.ts';
import { withDirLock } from '../dir-lock.ts';
import { readDoctorFingerprint } from '../doctor-fingerprint.ts';
import { STIM_VERSION } from '../stim-version.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import {
  fingerprintOptions,
  fingerprintProject,
  type FingerprintTarget,
  type ProjectFingerprint,
} from './build-cache.ts';

export const FINGERPRINT_MEMO_TTL_MS: number = 24 * 60 * 60 * 1000;

/** git's racy-clean window: an input changed this close to the fingerprint's start is never recorded as clean. */
const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * Per-shell variables, and the run id the CLI sets for each run, that are not config inputs; every other change to
 * the environment forces a full fingerprint.
 */
const ENV_DENYLIST = new Set([
  'STIM_RUN_ID',
  '_',
  'OLDPWD',
  'PWD',
  'SHLVL',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'SECURITYSESSIONID',
  'WINDOWID',
]);

/**
 * `statfs` f_type values of local volumes with nanosecond timestamps: APFS on macOS; ext4, btrfs, xfs and tmpfs on
 * Linux. Other volumes always fingerprint in full, because their clock or timestamp granularity cannot be trusted.
 */
const NANOSECOND_VOLUMES: Partial<Record<NodeJS.Platform, ReadonlySet<number>>> = {
  darwin: new Set([0x1a]),
  linux: new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994]),
};

const PACKAGE_MARKERS = [
  'package.json',
  'expo-module.config.json',
  'react-native.config.js',
  'react-native.config.ts',
  'react-native.config.cjs',
  'react-native.config.mjs',
  'ios',
  'android',
  'android/build.gradle',
  'android/build.gradle.kts',
  'android/src/main/AndroidManifest.xml',
];

/** Fixed-path inputs at the project root, stamped whether present or absent so that creating one is seen. */
const APP_MARKERS = [
  'modules',
  'patches',
  'cng-patches',
  'eas.json',
  '.easignore',
  '.gitignore',
  'react-native.config.js',
  'react-native.config.ts',
  'react-native.config.cjs',
  'react-native.config.mjs',
  'expo-module.config.json',
];

const INSTALL_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-integrity',
  'node_modules/.yarn-state.yml',
  '.yarn/install-state.gz',
];

type MemoPlatform = 'ios' | 'android';
type NormalizedOptions = Awaited<ReturnType<typeof normalizeOptionsAsync>>;

interface PreparedMemo {
  operation: StimContext;
  projectRoot: string;
  platform: MemoPlatform;
  target: FingerprintTarget;
  normalized: NormalizedOptions;
  identity: string;
}

interface FingerprintCheckResult {
  status: 'confirmed' | 'stale' | 'failed';
  recorded: string;
  current: string | null;
}

/** The full fingerprint a memo hit runs in the background; settle() drops the record unless it agrees. */
export interface FingerprintCheck {
  settle(): Promise<FingerprintCheckResult>;
  cancel(): void;
}

export type BackgroundFingerprint = (
  operation: StimContext,
  projectRoot: string,
  target: FingerprintTarget,
  signal: AbortSignal,
) => Promise<ProjectFingerprint | null>;

const require = createRequire(import.meta.url);

function fingerprintVersion(): string {
  const version: unknown = require('@expo/fingerprint/package.json').version;
  if (typeof version !== 'string') throw new Error('no @expo/fingerprint version');
  return version;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isSourceList(sources: unknown[]): sources is FingerprintSource[] {
  return sources.every(
    (source) =>
      source !== null &&
      typeof source === 'object' &&
      'type' in source &&
      (source.type === 'file' || source.type === 'dir' || source.type === 'contents'),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function envDigest(env: NodeJS.ProcessEnv): string {
  return digest(
    Object.entries(env)
      .filter(([key, value]) => value !== undefined && !ENV_DENYLIST.has(key))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function onNanosecondVolume(path: string): boolean {
  return NANOSECOND_VOLUMES[process.platform]?.has(statfsSync(path).type) ?? false;
}

/** The loader @expo/fingerprint evaluates the app config with; not public API, so any mismatch disables the memo. */
async function evaluateExpoConfig(memo: PreparedMemo): Promise<string> {
  const loader: unknown = await import('@expo/fingerprint/build/ExpoConfig.js');
  const getExpoConfigAsync =
    loader && typeof loader === 'object' && 'getExpoConfigAsync' in loader ? loader.getExpoConfigAsync : null;
  if (typeof getExpoConfigAsync !== 'function') throw new Error('@expo/fingerprint has no getExpoConfigAsync');
  const result: unknown = await getExpoConfigAsync(memo.projectRoot, memo.normalized);
  if (!result || typeof result !== 'object' || !('config' in result) || !('loadedModules' in result))
    throw new Error('getExpoConfigAsync returned an unknown shape');
  return digest({ config: result.config ?? null, loadedModules: result.loadedModules ?? null });
}

async function prepareMemo(
  operation: StimContext,
  projectRoot: string,
  platform: MemoPlatform,
  target: FingerprintTarget,
): Promise<PreparedMemo | string> {
  const root = realpathSync(projectRoot);
  if (!onNanosecondVolume(root)) return 'the project is not on a local volume with nanosecond timestamps';
  const normalized = await normalizeOptionsAsync(projectRoot, await fingerprintOptions(projectRoot, target));
  if (typeof normalized.fileHookTransform === 'function') return 'fingerprint.config.js sets fileHookTransform';
  const identity = digest({
    schema: FINGERPRINT_MEMO_SCHEMA,
    stim: STIM_VERSION,
    fingerprint: fingerprintVersion(),
    platform,
    root,
    options: {
      platforms: normalized.platforms ?? null,
      hashAlgorithm: normalized.hashAlgorithm ?? null,
      sourceSkips: normalized.sourceSkips ?? null,
      enableReactImportsPatcher: normalized.enableReactImportsPatcher ?? null,
      useRNCoreAutolinkingFromExpo: normalized.useRNCoreAutolinkingFromExpo ?? null,
      useCNGForPlatforms: normalized.useCNGForPlatforms,
      ignorePaths: normalized.ignorePathMatchObjects.map((match) => match.pattern),
      extraSources: normalized.extraSources ?? null,
    },
    env: envDigest(operation.env),
  });
  return { operation, projectRoot, platform, target, normalized, identity };
}

function stampOf(path: string): { kind: FingerprintMemoRow[1]; stamp: string; ctimeNs: bigint | null } {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return { kind: '-', stamp: '', ctimeNs: null };
  return {
    kind: stat.isDirectory() ? 'd' : 'f',
    stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    ctimeNs: stat.ctimeNs,
  };
}

function rowsUnchanged(rows: readonly FingerprintMemoRow[]): boolean {
  for (const [path, kind, stamp] of rows) {
    const now = stampOf(path);
    if (now.kind !== kind || now.stamp !== stamp) return false;
  }
  return true;
}

function packageRoot(path: string): string | null {
  let dir = path;
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && key in value ? Reflect.get(value, key) : undefined;

/** The `nativeModulesDir` and `searchPaths` that `expo.autolinking` in package.json gives expo-modules-autolinking. */
function autolinkingDirs(projectRoot: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const autolinking = field(field(manifest, 'expo'), 'autolinking');
  const dirs: string[] = [];
  for (const options of [autolinking, field(autolinking, 'ios'), field(autolinking, 'android')]) {
    const nativeModulesDir = field(options, 'nativeModulesDir');
    if (typeof nativeModulesDir === 'string') dirs.push(nativeModulesDir);
    const searchPaths = field(options, 'searchPaths');
    if (Array.isArray(searchPaths)) dirs.push(...searchPaths.filter((path) => typeof path === 'string'));
  }
  return dirs;
}

function installRoots(projectRoot: string): string[] {
  const roots: string[] = [];
  let dir = projectRoot;
  for (;;) {
    roots.push(dir);
    const parent = dirname(dir);
    if (existsSync(join(dir, '.git')) || parent === dir) return roots;
    dir = parent;
  }
}

function linkedPackages(nodeModules: string): string[] {
  let names: string[];
  try {
    names = readdirSync(nodeModules);
  } catch {
    return [];
  }
  const entries = names.flatMap((name) => {
    if (!name.startsWith('@')) return [join(nodeModules, name)];
    try {
      return readdirSync(join(nodeModules, name)).map((scoped) => join(nodeModules, name, scoped));
    } catch {
      return [];
    }
  });
  return entries.flatMap((entry) => {
    try {
      if (!lstatSync(entry).isSymbolicLink()) return [];
      const real = realpathSync(entry);
      return real.includes(`${sep}node_modules${sep}`) ? [] : [real];
    } catch {
      return [];
    }
  });
}

/**
 * Every path whose state the recorded fingerprint depends on: the files it hashed and the directories it walked
 * (whose times change when an entry is added), plus an autolinking proxy of package manifests, lockfiles, install
 * markers and each autolinked or workspace-linked package's own markers.
 */
function inputPaths(memo: PreparedMemo, sources: readonly FingerprintSource[]): string[] {
  const { projectRoot, normalized } = memo;
  const paths = new Set<string>();
  const walk = (dir: string): void => {
    if (isIgnoredPathWithMatchObjects(dir, normalized.ignoreDirMatchObjects)) return;
    paths.add(resolve(projectRoot, dir));
    for (const entry of readdirSync(join(projectRoot, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !isIgnoredPathWithMatchObjects(path, normalized.ignorePathMatchObjects))
        paths.add(resolve(projectRoot, path));
    }
  };
  const packages = new Set<string>();
  for (const source of sources) {
    if (source.type === 'file' && source.hash !== null) paths.add(resolve(projectRoot, source.filePath));
    if (source.type !== 'dir') continue;
    if (existsSync(join(projectRoot, source.filePath))) walk(source.filePath);
    if (source.reasons.some((reason) => /autolinking|rncli/i.test(reason))) {
      paths.add(resolve(projectRoot, source.filePath));
      const root = packageRoot(resolve(projectRoot, source.filePath));
      if (root) packages.add(root);
    }
  }
  for (const marker of APP_MARKERS) paths.add(join(projectRoot, marker));
  for (const dir of autolinkingDirs(projectRoot)) paths.add(resolve(projectRoot, dir));
  for (const root of installRoots(realpathSync(projectRoot))) {
    for (const marker of INSTALL_MARKERS) paths.add(join(root, marker));
    for (const linked of linkedPackages(join(root, 'node_modules'))) packages.add(linked);
  }
  try {
    paths.add(createRequire(join(projectRoot, 'package.json')).resolve('react-native/package.json'));
  } catch {}
  for (const root of packages) {
    paths.add(root);
    for (const marker of PACKAGE_MARKERS) paths.add(join(root, marker));
  }
  return [...paths].toSorted();
}

function writeRecord(memo: PreparedMemo, record: FingerprintMemoRecord): void {
  const file = workspaceFingerprintMemoFile(memo.projectRoot, memo.platform);
  withDirLock(
    workspaceFingerprintMemoLock(memo.projectRoot),
    () => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, file);
    },
    { ensureParent: () => ensureWorkspaceStorage(memo.projectRoot) },
  );
}

function restoreRecord(memo: PreparedMemo, record: FingerprintMemoRecord): void {
  const file = workspaceFingerprintMemoFile(memo.projectRoot, memo.platform);
  withDirLock(workspaceFingerprintMemoLock(memo.projectRoot), () => {
    if (existsSync(file) || !existsSync(dirname(file))) return;
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  });
}

function dropFingerprintMemo(projectRoot: string, platform: MemoPlatform): void {
  const file = workspaceFingerprintMemoFile(projectRoot, platform);
  if (!existsSync(file)) return;
  withDirLock(workspaceFingerprintMemoLock(projectRoot), () => rmSync(file, { force: true }));
}

/** Writes the record only when no input changed within the racy window before the fingerprint started. */
function recordFingerprint(
  memo: PreparedMemo,
  computed: ProjectFingerprint,
  configDigest: string,
  startedAt: number,
): string | null {
  const limit = BigInt(startedAt) * 1_000_000n - RACY_WINDOW_NS;
  const devices = new Map<string, string>();
  const rows: FingerprintMemoRow[] = [];
  for (const path of inputPaths(memo, computed.sources)) {
    const { kind, stamp, ctimeNs } = stampOf(path);
    if (ctimeNs !== null && ctimeNs >= limit) return `${path} changed while it was fingerprinted`;
    if (kind !== '-') devices.set(stamp.slice(0, stamp.indexOf(':')), path);
    rows.push([path, kind, stamp]);
  }
  for (const path of devices.values())
    if (!onNanosecondVolume(path)) return `${path} is not on a local volume with nanosecond timestamps`;
  writeRecord(memo, {
    schema: FINGERPRINT_MEMO_SCHEMA,
    identity: memo.identity,
    recordedAt: startedAt,
    hash: computed.hash,
    sources: computed.sources,
    configDigest,
    rows,
  });
  return null;
}

const runBackgroundFingerprint: BackgroundFingerprint = (operation, projectRoot, target, signal) =>
  readDoctorFingerprint(
    { ...operation, signal },
    {
      root: projectRoot,
      ...(target.platform ? { platform: target.platform } : {}),
      ...(target.iosProjectPath ? { iosProjectPath: target.iosProjectPath } : {}),
      ...(target.androidLayout ? { androidLayout: target.androidLayout } : {}),
    },
    { lowPriority: true },
  );

/** Puts back the record the hit dropped, only when the check agrees and no other run has written one since. */
function startCheck(
  memo: PreparedMemo,
  stored: FingerprintMemoRecord,
  background: BackgroundFingerprint,
): FingerprintCheck {
  const controller = new AbortController();
  const signal = AbortSignal.any([memo.operation.signal, controller.signal]);
  const result = background(memo.operation, memo.projectRoot, memo.target, signal)
    .then(
      (computed) => ({ hash: computed?.hash ?? null, failure: computed?.hash ? null : 'no hash' }),
      (error: unknown) => ({ hash: null, failure: errorMessage(error) }),
    )
    .then(({ hash, failure }): FingerprintCheckResult => {
      const status = hash === stored.hash ? 'confirmed' : hash === null ? 'failed' : 'stale';
      if (status === 'confirmed') {
        try {
          restoreRecord(memo, stored);
        } catch {}
      }
      debugLog.log('fingerprint_memo_check', { platform: memo.platform, status, ...(failure ? { failure } : {}) });
      return { status, recorded: stored.hash, current: hash };
    });
  return { settle: () => result, cancel: () => controller.abort() };
}

export interface MemoizedFingerprint {
  fingerprint: ProjectFingerprint | null;
  /** True when the recorded fingerprint was used instead of computing one. */
  memoHit: boolean;
  check: FingerprintCheck | null;
}

/**
 * The fingerprint for a pre-mutation cache lookup. With `consult`, a record whose identity, environment, input stats
 * and evaluated app config all match, and that is under 24 hours old, stands in for the full fingerprint, and a full
 * fingerprint then runs in the background as `check`. With `record`, a full fingerprint is recorded for the next
 * run. Any memo failure falls back to the full fingerprint; errors from the fingerprint itself propagate.
 */
export async function memoizedFingerprint(
  projectRoot: string,
  target: FingerprintTarget & { platform: MemoPlatform },
  {
    consult,
    record,
    operation,
    fingerprint = fingerprintProject,
    background = runBackgroundFingerprint,
    now = Date.now,
  }: {
    consult: boolean;
    record: boolean;
    operation?: StimContext;
    fingerprint?: typeof fingerprintProject;
    background?: BackgroundFingerprint;
    now?: () => number;
  },
): Promise<MemoizedFingerprint> {
  const full = (): Promise<ProjectFingerprint | null> => fingerprint(projectRoot, target);
  const startedAt = now();
  const skip = (reason: string): void => debugLog.log('fingerprint_memo_skip', { platform: target.platform, reason });
  let memo: PreparedMemo | null = null;
  if (operation && (consult || record)) {
    try {
      const prepared = await prepareMemo(operation, projectRoot, target.platform, target);
      if (typeof prepared === 'string') skip(prepared);
      else memo = prepared;
    } catch (error) {
      skip(errorMessage(error));
    }
  }
  if (!memo) return { fingerprint: await full(), memoHit: false, check: null };

  let config: string | null = null;
  if (consult) {
    try {
      const stored = readFingerprintMemo(projectRoot, target.platform);
      const age = stored ? startedAt - stored.recordedAt : 0;
      if (!stored) skip('no record');
      else if (stored.identity !== memo.identity) skip('identity or environment changed');
      else if (age < 0 || age > FINGERPRINT_MEMO_TTL_MS) skip('record expired');
      else if (!rowsUnchanged(stored.rows)) skip('an input changed');
      else {
        config = await evaluateExpoConfig(memo);
        if (config !== stored.configDigest) skip('the app config changed');
        else if (!isSourceList(stored.sources)) skip('the record has unknown sources');
        else {
          if (record) dropFingerprintMemo(projectRoot, target.platform);
          debugLog.log('fingerprint_memo_hit', { platform: target.platform });
          return {
            fingerprint: { hash: stored.hash, sources: stored.sources },
            memoHit: true,
            check: record ? startCheck(memo, stored, background) : null,
          };
        }
      }
    } catch (error) {
      skip(errorMessage(error));
    }
  }
  if (!record) return { fingerprint: await full(), memoHit: false, check: null };

  const known = config;
  const [computed, evaluated] = await Promise.all([
    full(),
    known ??
      evaluateExpoConfig(memo).catch((error: unknown) => {
        skip(errorMessage(error));
        return null;
      }),
  ]);
  if (computed?.hash && evaluated) {
    try {
      const refused = recordFingerprint(memo, computed, evaluated, startedAt);
      if (refused) skip(refused);
    } catch (error) {
      skip(errorMessage(error));
    }
  }
  return { fingerprint: computed, memoHit: false, check: null };
}

/** Waits for a memo hit's background fingerprint and reports a disagreement, which has already dropped the record. */
export async function settleFingerprintCheck(
  check: FingerprintCheck | null | undefined,
  platform: MemoPlatform,
  warn: (line: string) => void,
  log?: (record: Record<string, unknown>) => void,
): Promise<void> {
  if (!check) return;
  const { status, recorded, current } = await check.settle();
  if (status !== 'stale' || !current) return;
  const line =
    `the recorded fingerprint ${shortHash(recorded)} no longer matches the tree (${shortHash(current)}), ` +
    `so this run looked up the build cache with a stale key; run stim ${platform} again to use the current tree`;
  warn(line);
  log?.({ src: 'build', level: 'warn', event: 'fingerprint_memo_stale', msg: line, recorded, current });
}
