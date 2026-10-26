import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { easCache } from './eas-cache.ts';
import { operationState } from './operation-state.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { stripAnsi } from '../process-output.ts';
import { resolvePackageJson } from '../workspace/project.ts';
import { expoBinFromPackage, expoBinPath, expoTelemetryEnv, findBinUpward } from '../supervisor/server-expo.ts';
import type { FingerprintSource } from '@expo/fingerprint';
import { expoConfigContents } from '../cache/build-cache.ts';
import { remoteCommand } from './node-cli.ts';

export const EAS_PROVIDER_PACKAGE = 'eas-build-cache-provider';

export const LOCAL_PROVIDER_PACKAGE = '@stim-cli/expo-build-cache';

export const RESOLVE_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const CONFIG_TIMEOUT_MS = 30_000;

const DYNAMIC_CONFIG_FILES = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'];

type ProjectConfig = Record<string, unknown>;

type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
) => string | Promise<string>;

interface ReadProjectConfigResult {
  config?: ProjectConfig | null;
  source?: string | null;
  unavailable?: string;
}

interface NormalizedProvider {
  name?: string;
  reference?: string;
  invalid?: string;
}

type LoadedProvider = { easCli: string; nodeEntry?: true };

export interface LoadProjectProviderResult {
  provider?: LoadedProvider;
  name?: string;
  owner?: string | null;
  none?: true;
  unavailable?: string;
}

interface WhoamiResult {
  loggedOut?: true;
  unknown?: string;
  loggedIn?: true;
  account?: string;
  accounts?: string[] | null;
  viaToken?: boolean;
}

interface EasAuthNoteStatus {
  code?: string;
  account?: string | null;
  owner?: string;
  reason?: string;
  phase?: 'resolve' | 'upload';
}

export interface EasAuthResult {
  ok?: true;
  account?: string | null;
  accounts?: string[] | null;
  viaToken?: boolean;
  source?: string;
  failed?: true;
  code?: 'no-cli' | 'logged-out' | 'wrong-account' | 'project-cli';
  reason?: string;
  remedy?: string;
  owner?: string;
  unknown?: string;
}

export interface RemoteCacheResolveResult {
  appPath?: string;
  failed?: string;
  timedOut?: true;
}

export interface RemoteCacheUploadResult {
  uploaded?: true;
  destination?: string;
  failed?: string;
  timedOut?: true;
  skipped?: true;
}

export function dynamicConfigFile(root: string): string | null {
  for (const name of DYNAMIC_CONFIG_FILES) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

export function providerFromConfig(config?: ProjectConfig | null): unknown {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as {
    buildCacheProvider?: unknown;
    experiments?: { buildCacheProvider?: unknown };
  };
  return exp.buildCacheProvider ?? exp.experiments?.buildCacheProvider ?? null;
}

export function ownerFromConfig(config?: ProjectConfig | null): string | null {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as { owner?: unknown };
  const owner = exp.owner;
  return typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null;
}

export function normalizeProvider(raw: unknown): NormalizedProvider | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw === 'eas') return { name: 'eas', reference: EAS_PROVIDER_PACKAGE };
  if (typeof raw === 'object') {
    const obj = raw as { plugin?: unknown };
    if (typeof obj.plugin === 'string' && obj.plugin.trim() !== '') {
      const reference = obj.plugin.trim();
      return {
        name: reference,
        reference,
      };
    }
  }
  return { invalid: typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw) };
}

export function runOptionsFor(platform?: string | null): { variant: string } | { configuration: string } {
  return platform === 'android' ? { variant: 'debug' } : { configuration: 'Debug' };
}

export function cacheLevel(value: unknown): 'local' | 'remote' | false {
  return value === 'local' || value === 'remote' ? value : false;
}

export async function readProjectConfig(
  root: string,
  {
    context,
    run = null,
    timeoutMs = CONFIG_TIMEOUT_MS,
  }: { context?: StimContext; run?: ExecFileFn | null; timeoutMs?: number } = {},
): Promise<ReadProjectConfigResult> {
  const dynamic = dynamicConfigFile(root);
  if (!dynamic) {
    const file = join(root, 'app.json');
    if (!existsSync(file)) return { config: null, source: null };
    try {
      return { config: JSON.parse(readFileSync(file, 'utf-8')), source: 'app.json' };
    } catch (err) {
      return { unavailable: `app.json could not be parsed: ${firstLine(err)}` };
    }
  }

  const bin = expoBinPath(root);
  if (!bin) {
    return {
      unavailable:
        `${dynamic} is code, so it has to be evaluated to read its buildCacheProvider, ` +
        'and the `expo` package is not resolvable from this project ' +
        '(no expo/package.json to read a bin from, and no node_modules/.bin/expo here or in any parent)',
    };
  }
  const exec: ExecFileFn =
    run ||
    ((file, args, opts) => remoteCommand({ operation: context, expoBin: file }, file, args, { ...opts, cwd: root }));
  let stdout;
  try {
    stdout = await exec(bin, ['config', '--json', root], {
      timeoutMs,
      env: expoTelemetryEnv(context?.env ?? process.env),
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'STIM_CLAIM_UNAVAILABLE') throw err;
    context?.signal.throwIfAborted();
    return { unavailable: `\`expo config --json\` failed: ${firstLine(err)}` };
  }
  try {
    return { config: JSON.parse(String(stdout)), source: dynamic };
  } catch (err) {
    return { unavailable: `\`expo config --json\` did not print JSON: ${firstLine(err)}` };
  }
}

/**
 * The app config the fingerprint already evaluated, for a dynamic config. @expo/fingerprint's ExpoConfigEASProject
 * skip removes `owner`, so a missing owner under the EAS provider cannot be told from a stripped one and is read from
 * `expo config --json` instead.
 */
function fingerprintedConfig(
  projectRoot: string,
  sources?: readonly FingerprintSource[],
): ReadProjectConfigResult | null {
  if (!sources || !dynamicConfigFile(projectRoot)) return null;
  const config = expoConfigContents(sources);
  if (!config) return null;
  const provider = normalizeProvider(providerFromConfig(config));
  if (provider?.reference === EAS_PROVIDER_PACKAGE && ownerFromConfig(config) === null) return null;
  return { config, source: 'fingerprint' };
}

export async function loadProjectProvider(
  projectRoot: string,
  {
    context,
    isExpo = true,
    run = null,
    requireFrom = null,
    timeoutMs = CONFIG_TIMEOUT_MS,
    sources,
  }: {
    context?: StimContext;
    isExpo?: boolean;
    run?: ExecFileFn | null;
    requireFrom?: ((root: string) => NodeRequire) | null;
    timeoutMs?: number;
    sources?: readonly FingerprintSource[];
  } = {},
): Promise<LoadProjectProviderResult> {
  if (!isExpo) return { none: true };

  const read =
    fingerprintedConfig(projectRoot, sources) ?? (await readProjectConfig(projectRoot, { context, run, timeoutMs }));
  if (read.unavailable) return { unavailable: read.unavailable };

  const normalized = normalizeProvider(providerFromConfig(read.config));
  if (!normalized) return { none: true };
  if (normalized.invalid) {
    return { unavailable: `buildCacheProvider is ${normalized.invalid}, which is not "eas" or { plugin: <module> }` };
  }
  if (normalized.reference === LOCAL_PROVIDER_PACKAGE) return { none: true };
  if (normalized.reference !== EAS_PROVIDER_PACKAGE)
    return {
      unavailable: 'Custom Expo buildCacheProvider plugins are not supported. Use EAS or a Stim cache provider.',
    };

  try {
    const localRequire = requireFrom ? requireFrom(projectRoot) : createRequire(join(projectRoot, 'package.json'));
    localRequire.resolve(EAS_PROVIDER_PACKAGE);
    const bin = resolveEasCliBin(projectRoot);
    if (!bin) return { unavailable: 'the EAS build cache needs an installed eas-cli executable' };
    const entry =
      expoBinFromPackage(resolvePackageJson(projectRoot, 'eas-cli'), 'eas') ??
      expoBinFromPackage(resolvePackageJson(dirname(realpathSync(bin.file)), 'eas-cli'), 'eas');
    if (entry && !/\.(cmd|bat)$/i.test(entry)) {
      return {
        provider: { easCli: entry, nodeEntry: true },
        name: normalized.name,
        owner: ownerFromConfig(read.config),
      };
    }
    if (process.platform === 'win32') {
      return { unavailable: 'the EAS build cache needs an installed eas-cli package to cancel its Node process' };
    }
    return { provider: { easCli: bin.file }, name: normalized.name, owner: ownerFromConfig(read.config) };
  } catch (err) {
    if (err instanceof WorkspaceProcessCleanupError || (err instanceof Error && 'reportCleanup' in err)) throw err;
    context?.signal.throwIfAborted();
    operationState(context).runSignal?.throwIfAborted();
    const missing = (err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND';
    return {
      unavailable:
        normalized.name === 'eas' && missing
          ? `the EAS build cache needs the \`${EAS_PROVIDER_PACKAGE}\` package, which is not installed in this project`
          : `${normalized.name} could not be loaded: ${firstLine(err)}`,
    };
  }
}

export const WHOAMI_TIMEOUT_MS = 15_000;

const EAS_CLI_PACKAGE = 'eas-cli';
const EAS_CLI_BIN = 'eas';

export function parseWhoami({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: { stdout?: string; stderr?: string; exitCode?: number } = {}): WhoamiResult {
  const out = stripAnsi(stdout);
  const combined = `${out}\n${stripAnsi(stderr)}`;
  if (/^\s*Not logged in\s*$/m.test(combined)) return { loggedOut: true };
  if (exitCode !== 0) {
    return { unknown: firstLine(combined.trim() || `eas whoami exited ${exitCode}`) };
  }
  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { unknown: 'eas whoami printed nothing' };

  const raw = lines[0];
  if (raw === undefined) return { unknown: 'eas whoami printed nothing' };
  const viaToken = /\(authenticated using EXPO_TOKEN\)\s*$/.test(raw);
  const display = raw.replace(/\s*\(authenticated using EXPO_TOKEN\)\s*$/, '').trim();

  const accounts: string[] = [];
  for (const line of lines) {
    const m = /^\u2022\s*(\S+)\s*\(Role:/.exec(line);
    const name = m?.[1];
    if (name !== undefined) accounts.push(name);
  }
  if (accounts.length === 0 && !display.endsWith('(robot)') && display !== 'robot') {
    accounts.push(display);
  }
  return {
    loggedIn: true,
    account: display,
    accounts: accounts.length ? accounts : null,
    viaToken,
  };
}

export function isEasAuthFailureText(text?: string | null): boolean {
  const t = stripAnsi(text || '');
  if (t.trim() === '') return false;
  return (
    /not logged in/i.test(t) ||
    /\beas login\b/i.test(t) ||
    /EXPO_TOKEN/.test(t) ||
    /unauthorized/i.test(t) ||
    /not authorized/i.test(t) ||
    /authentication (failed|required)/i.test(t)
  );
}

export function easAuthNote(status?: EasAuthNoteStatus | null): string | null {
  const { code, account, owner, reason, phase = 'resolve' } = status || {};
  const because = reason ? ` (${reason})` : '';
  if (code === 'logged-out') {
    return (
      `eas is not authenticated${because} -- run \`eas login\` (or set EXPO_TOKEN); ` +
      (phase === 'upload' ? 'this build stayed in the local cache' : 'building with the local cache only')
    );
  }
  if (code === 'wrong-account') {
    return (
      `eas is authenticated as ${account}, and this project's owner is ${owner} -- ` +
      `run \`eas login\` as a member of ${owner} (or set EXPO_TOKEN); consulting the EAS cache anyway`
    );
  }
  return null;
}

export function resolveEasCliBin(
  projectRoot: string,
  { lookupPath = null }: { lookupPath?: (() => string | null) | null } = {},
): { file: string; source: 'project' | 'path' } | null {
  const fromPackage = expoBinFromPackage(resolvePackageJson(projectRoot, EAS_CLI_PACKAGE), EAS_CLI_BIN);
  if (fromPackage) return { file: fromPackage, source: 'project' };
  const shim = findBinUpward(projectRoot, EAS_CLI_BIN);
  if (shim) return { file: shim, source: 'project' };
  const onPath = lookupPath ? lookupPath() : getExecutor().findExecutable(EAS_CLI_BIN);
  const file = (String(onPath || '').split('\n')[0] ?? '').trim();
  return file ? { file, source: 'path' } : null;
}

const easAuthCache = new Map<string, Promise<EasAuthResult>>();
const operationAuthCaches = new WeakMap<StimContext, Map<string, Promise<EasAuthResult>>>();

/** @internal Test seam that clears the per-process EAS auth cache. */
export function resetEasAuthCache(): void {
  easAuthCache.clear();
}

interface CheckEasAuthOptions {
  context?: StimContext;
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs?: number;
  cache?: Map<string, Promise<EasAuthResult>> | null;
}

type ExecFileError = NodeJS.ErrnoException & {
  signal?: string | null;
  killed?: boolean;
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
};

export async function checkEasAuth({
  context,
  projectRoot,
  owner = null,
  run = null,
  resolveBin = null,
  timeoutMs = WHOAMI_TIMEOUT_MS,
  cache,
}: CheckEasAuthOptions): Promise<EasAuthResult> {
  if (cache === undefined) {
    if (context) {
      cache = operationAuthCaches.get(context);
      if (!cache) {
        cache = new Map();
        operationAuthCaches.set(context, cache);
      }
    } else cache = easAuthCache;
  }
  const key = `${projectRoot}::${owner || ''}`;
  if (cache?.has(key)) return cache.get(key)!;
  const answer = probeEasAuth({ context, projectRoot, owner, run, resolveBin, timeoutMs });
  cache?.set(key, answer);
  return answer;
}

async function probeEasAuth({
  context,
  projectRoot,
  owner,
  run,
  resolveBin,
  timeoutMs,
}: {
  context?: StimContext;
  projectRoot: string;
  owner?: string | null;
  run?: ExecFileFn | null;
  resolveBin?: ((root: string) => { file: string; source: 'project' | 'path' } | null) | null;
  timeoutMs: number;
}): Promise<EasAuthResult> {
  const bin = (resolveBin || resolveEasCliBin)(projectRoot);
  if (!bin) {
    return {
      failed: true,
      code: 'no-cli',
      reason: 'no `eas` executable is resolvable from this project or on PATH',
      remedy: 'Install eas-cli (`npm i -g eas-cli`, or as a project devDependency), then run `eas login`.',
    };
  }

  const exec: ExecFileFn =
    run ||
    ((file, args, opts) =>
      remoteCommand({ operation: context, easBin: file }, file, args, { ...opts, cwd: projectRoot }));
  let result: { stdout: string; stderr?: string; exitCode: number };
  try {
    result = { stdout: String((await exec(bin.file, ['whoami'], { timeoutMs })) ?? ''), exitCode: 0 };
  } catch (e) {
    const err = e as ExecFileError;
    if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || err?.killed) {
      return { unknown: `eas whoami timed out after ${timeoutMs}ms` };
    }
    result = {
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
      exitCode: typeof err?.status === 'number' ? err.status : 1,
    };
  }

  const parsed = parseWhoami(result);
  if (parsed.loggedOut) {
    return {
      failed: true,
      code: 'logged-out',
      reason: 'eas whoami says "Not logged in"',
      remedy: 'Run `eas login` (or set EXPO_TOKEN).',
    };
  }
  if (parsed.unknown) return { unknown: parsed.unknown };

  if (owner && Array.isArray(parsed.accounts) && !parsed.accounts.includes(owner)) {
    return {
      failed: true,
      code: 'wrong-account',
      account: parsed.account,
      accounts: parsed.accounts,
      owner,
      reason:
        `eas is authenticated as ${parsed.account} (accounts: ${parsed.accounts.join(', ')}), ` +
        `which does not include this project's owner ${owner}`,
      remedy: `Run \`eas login\` as a member of ${owner}, or set EXPO_TOKEN to a token for it.`,
    };
  }
  return {
    ok: true,
    account: parsed.account,
    accounts: parsed.accounts,
    viaToken: parsed.viaToken,
    source: bin.source,
  };
}

interface ResolveRemoteOptions {
  context?: StimContext;
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: Pick<NdjsonWriter, 'write'> | null;
}

export async function resolveRemote({
  context,
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  runOptions = null,
  timeoutMs = RESOLVE_TIMEOUT_MS,
  logWriter = null,
}: ResolveRemoteOptions = {}): Promise<RemoteCacheResolveResult | null> {
  if (!provider || !fingerprintHash) return null;
  const opts = runOptions || runOptionsFor(platform);
  if (!projectRoot) return null;
  return easCache('resolve', {
    file: provider.easCli,
    nodeEntry: provider.nodeEntry,
    projectRoot,
    platform,
    fingerprintHash,
    runOptions: opts,
    timeoutMs,
    context,
    logWriter,
  });
}

interface UploadRemoteOptions {
  context?: StimContext;
  provider?: LoadedProvider | null;
  platform?: string | null;
  projectRoot?: string | null;
  fingerprintHash?: string | null;
  buildPath?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs?: number;
  logWriter?: Pick<NdjsonWriter, 'write'> | null;
  note?: (line: string) => void;
}

export async function uploadRemote({
  context,
  provider,
  platform,
  projectRoot,
  fingerprintHash,
  buildPath,
  runOptions = null,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  logWriter = null,
  note = (line: string) => (context ? context.output('stderr', `${line}\n`) : console.error(line)),
}: UploadRemoteOptions = {}): Promise<RemoteCacheUploadResult> {
  if (!provider || !fingerprintHash || !buildPath) return { skipped: true };
  const opts = runOptions || runOptionsFor(platform);
  if (!projectRoot) return { skipped: true };
  return (
    (await easCache('upload', {
      file: provider.easCli,
      nodeEntry: provider.nodeEntry,
      projectRoot,
      platform,
      fingerprintHash,
      runOptions: opts,
      buildPath,
      timeoutMs,
      context,
      logWriter,
      note,
    })) ?? { skipped: true }
  );
}

function firstLine(err: unknown): string {
  const text = String((err as Error)?.message || err || 'unknown error').trim();
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
