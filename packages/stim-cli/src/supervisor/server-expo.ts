import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMetroSharedCache } from '../optimizations.ts';
import { resolveProjectSettings, type SettingsObject } from '../workspace/settings.ts';
import { getExecutor } from '../exec.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { type NdjsonRecord, type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { stripAnsi } from '../process-output.ts';
import { type ChildServerHandle, superviseChildServer } from './child-server.ts';
import { resolvePackageJson } from '../workspace/project.ts';
import {
  expoMetroConfigPath,
  expoMetroStoreEnv,
  metroStoreConfirmedRoot,
  metroStoreRoot,
  registerMetroStore,
} from './metro-store.ts';
import { supervisorError } from './errors.ts';

function resolveExpoBin(root: string): { path: string; source: 'package' | 'shim' } | null {
  const fromPackage = expoBinFromPackage(resolvePackageJson(root, 'expo'));
  if (fromPackage) return { path: fromPackage, source: 'package' };
  const shim = findBinUpward(root, 'expo');
  return shim ? { path: shim, source: 'shim' } : null;
}

export function expoBinPath(root: string): string | null {
  return resolveExpoBin(root)?.path ?? null;
}

export function expoSdkMajor(root: string): number | null {
  const packageJsonPath = resolvePackageJson(root, 'expo');
  if (!packageJsonPath) return null;
  try {
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = (pkg as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') return null;
    const match = /^(\d+)/.exec(version);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function expoBinFromPackage(packageJsonPath: string | null, binName = 'expo'): string | null {
  if (!packageJsonPath) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a project's package.json, parsed defensively
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
  const bin = pkg?.bin;
  const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? bin[binName] : null;
  if (typeof rel !== 'string' || rel.trim() === '') return null;
  const file = join(dirname(packageJsonPath), rel);
  return isExecutableFile(file) ? file : null;
}

export function findBinUpward(
  startDir: string,
  name: string,
  { exists = existsSync }: { exists?: (p: string) => boolean } = {},
): string | null {
  const stop = repositoryRoot(startDir, exists) ?? startDir;
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'node_modules', '.bin', name);
    if (exists(candidate)) return candidate;
    if (dir === stop) return null;
    dir = dirname(dir);
  }
}

function repositoryRoot(startDir: string, exists: (p: string) => boolean): string | null {
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (exists(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function expoBinRefusal(
  root: string,
  what = 'start an Expo dev server for',
): { message: string; remedy: string } {
  return {
    message:
      `Cannot ${what} ${root}: the \`expo\` package is not resolvable from it` +
      ' (require.resolve("expo/package.json") failed, and no node_modules/.bin/expo exists in it or in any parent).',
    remedy:
      "Install the project's dependencies (in a monorepo, from the workspace root), or check that this package really depends on `expo`.",
  };
}

const CROSS = '\u2716';
const CROSS_MARK = '\u274C';
const WARNING_SIGN = '\u26A0';

const UNHANDLED_NAVIGATE =
  /The action '(?:NAVIGATE|NAVIGATE_DEPRECATED)' with payload .*was not handled by any navigator/;
const DEV_CLIENT_ROUTE = 'expo-development-client';

export function isDevClientNavigationNotice(line: unknown): boolean {
  const text = String(line);
  return text.includes(DEV_CLIENT_ROUTE) && UNHANDLED_NAVIGATE.test(text);
}

export function inferLevel(line: unknown): string {
  const text = String(line).trimStart();
  if (!text) return 'info';
  if (isDevClientNavigationNotice(text)) return 'info';
  const first = text[0];
  if (first === CROSS || first === CROSS_MARK) return 'error';
  if (first === WARNING_SIGN) return 'warn';
  const word = /^([A-Za-z]+)/.exec(text);
  const lead = word?.[1]?.toLowerCase() ?? '';
  if (lead === 'error' || lead === 'fatal') return 'error';
  if (lead === 'warn' || lead === 'warning') return 'warn';
  if (/\bBundling failed\b/.test(text)) return 'error';
  if (/^Unable to resolve\b/.test(text)) return 'error';
  if (/^Failed to (load|resolve|compile|build)\b/.test(text)) return 'error';
  if (/^[A-Z][A-Za-z]*Error:/.test(text)) return 'error';
  return 'info';
}

export function isBundleMarker(line: unknown): boolean {
  const text = String(line);
  return /\bBundled\b/.test(text) || /\bBundling failed\b/.test(text);
}

export function isBundleActivityLine(line: unknown): boolean {
  return /\bBundl(?:ing|ed)\b/.test(String(line));
}

export function cleanLine(line: unknown): string {
  const parts = stripAnsi(line).split('\r');
  return (parts[parts.length - 1] ?? '').trimEnd();
}

export function recordFromLine(
  line: unknown,
  { stream = 'stdout', source = 'expo' }: { stream?: string; source?: 'expo' | 'command' } = {},
): NdjsonRecord | null {
  const msg = cleanLine(line);
  if (!msg.trim()) return null;
  if (stream === 'stderr' && msg.startsWith('stim-bundle-response: ')) {
    try {
      const record = JSON.parse(msg.slice('stim-bundle-response: '.length));
      if (
        record.src === 'metro' &&
        /^bundle_(response|prefetch)_(started|progress|finished|failed)$/.test(record.event) &&
        ['ios', 'android'].includes(record.platform) &&
        typeof record.requestId === 'string' &&
        Number.isFinite(record.ts)
      )
        return record;
    } catch {}
  }
  const confirmed = metroStoreConfirmedRoot(msg);
  if (confirmed) {
    return {
      src: 'metro',
      level: 'debug',
      event: 'cache_store_added',
      msg: `sharing Metro transforms through ${confirmed} (the dev server process confirmed the store is in the config Metro loaded)`,
    };
  }
  const record: NdjsonRecord = {
    src: 'metro',
    level: inferLevel(msg),
    msg,
    raw: true,
    event: `${source}_${stream === 'stderr' ? 'stderr' : 'stdout'}`,
  };
  if (isBundleMarker(msg)) record.marker = true;
  return record;
}

export function expoProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.EXPO_PACKAGER_PROXY_URL) return {};
  const publicUrl = env.STIM_METRO_PUBLIC_URL?.trim();
  // Expo otherwise combines a tunnel host with the local Metro port in its manifest.
  return publicUrl ? { EXPO_PACKAGER_PROXY_URL: publicUrl.replace(/\/+$/, '') } : {};
}

const WAITING_ON_RE = /^Waiting on (\S+)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_SCHEME_RE = /^https?:\/\//i;

export function parseExpoWaitingOnUrl(line: unknown): string | null {
  const match = WAITING_ON_RE.exec(String(line ?? ''));
  if (!match) return null;
  const url = match[1] as string;
  if (HTTP_SCHEME_RE.test(url)) return url;
  return URL_SCHEME_RE.test(url) ? url.replace(/^[^:]+:/, 'https:') : url;
}

function resolveMetroStoreInjection(
  root: string,
  { log, env, settings }: { log: NdjsonWriter; env: NodeJS.ProcessEnv; settings: SettingsObject },
): Record<string, string> | null {
  const sharedCache = resolveMetroSharedCache(settings);
  if (!sharedCache) {
    log.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_skipped',
      msg: 'the shared Metro transform store is off in configuration',
    });
  }
  const sdkMajor = expoSdkMajor(root);
  if (sdkMajor === null || sdkMajor < 54) {
    log.write({
      src: 'metro',
      level: 'debug',
      event: 'cache_store_skipped',
      msg:
        sdkMajor === null
          ? "could not determine this project's Expo SDK, so Stim left its Metro cache unchanged"
          : `Expo SDK ${sdkMajor} predates the config override added in SDK 54, so it runs with its normal Metro cache`,
    });
    return null;
  }
  const adapterPath = expoMetroConfigPath();
  if (!adapterPath) {
    log.write({
      src: 'metro',
      level: 'warn',
      event: 'cache_store_skipped',
      msg: "Stim's Expo Metro config adapter is missing from this install, so the dev server runs on whatever transform cache the project configured",
    });
    return null;
  }
  const storeRoot = sharedCache ? metroStoreRoot(root) : '';
  const additions = expoMetroStoreEnv({
    root,
    storeRoot,
    adapterPath,
    existingOverride: env.EXPO_OVERRIDE_METRO_CONFIG,
  });
  if (!sharedCache) return additions;
  registerMetroStore(storeRoot);
  log.write({
    src: 'metro',
    level: 'debug',
    event: 'cache_store_requested',
    msg:
      `asked this project's Expo dev server to share Metro transforms through ${storeRoot} ` +
      '(EXPO_OVERRIDE_METRO_CONFIG, no metro.config.js change); the config adapter in that process reports the outcome',
  });
  return additions;
}

export async function startExpoServer({
  root,
  port,
  logsDir,
  writer = null,
  spawnFn = null,
  killTimeoutMs = 5000,
  tunnel = false,
  resetCache = false,
  onTunnelUrl = null,
  platform = process.platform,
  settings,
}: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
  killTimeoutMs?: number;
  tunnel?: boolean;
  resetCache?: boolean;
  onTunnelUrl?: ((url: string) => void) | null;
  platform?: NodeJS.Platform;
  settings?: SettingsObject;
}): Promise<ChildServerHandle> {
  const resolved = resolveExpoBin(root);
  if (!resolved) {
    const refusal = expoBinRefusal(root);
    throw supervisorError('STIM_EXPO_BIN', refusal.message, refusal.remedy);
  }
  const bin = resolved.path;

  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));

  const args = ['start', '--port', String(port), ...(tunnel ? ['--tunnel'] : []), ...(resetCache ? ['--clear'] : [])];
  const storeEnv = resolveMetroStoreInjection(root, {
    log,
    env: process.env,
    settings: settings ?? resolveProjectSettings(root).settings,
  });

  // On Windows the package bin's shebang resolves `node` through PATH, where pnpm
  // and Volta install shims that run the real node as a child. Metro then listens
  // in a grandchild, and with no readable cwd on win32 resolveProjectMetro only
  // accepts the recorded serverPid, so the supervisor runs its own node directly.
  const runWithOwnNode = platform === 'win32' && resolved.source === 'package';
  const [command, commandArgs] = runWithOwnNode ? [process.execPath, [bin, ...args]] : [bin, args];
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ...expoProxyEnv(process.env),
      ...storeEnv,
      // Expo's legacy tunnel uses port 8081; v2 uses this workspace's reserved port.
      ...(tunnel ? { EXPO_UNSTABLE_TUNNEL_V2: '1' } : {}),
    },
  });

  let tunnelUrlSeen = false;
  return superviseChildServer({
    mode: 'expo-child',
    child,
    log,
    toRecord: (chunk, stream) => recordFromLine(chunk, { stream }),
    signal: (sig) => child.kill(sig),
    killTimeoutMs,
    onRecord: (record) => {
      if (!tunnel || tunnelUrlSeen || !onTunnelUrl || typeof record.msg !== 'string') return;
      const url = parseExpoWaitingOnUrl(record.msg);
      if (url) {
        tunnelUrlSeen = true;
        onTunnelUrl(url);
      }
    },
  });
}
