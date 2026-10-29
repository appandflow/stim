import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  artifactIn,
  buildCacheRoot,
  buildCacheKey,
  hostSimulatorArch,
  registerCache,
  resolveArtifact,
  storeArtifactAsync,
} from '@stim-cli/core';
import type { BuildRunOptions as RunOptions } from '@stim-cli/core';

export { buildCacheKey };

let registeredDir: string | null = null;
import { execFile, execFileSync } from 'node:child_process';

export function cacheRoot(): string {
  return buildCacheRoot();
}

function entryDir(platform: string, key: string): string {
  return path.join(cacheRoot(), platform, key);
}

function shortKey(key: string, fingerprintHash: string): string {
  return `${String(fingerprintHash).slice(0, 12)}${key.slice(String(fingerprintHash).length)}`;
}

const ANDROID_ABIS = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];

function adbPath(): string {
  const configured = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const home = os.homedir();
  const sdk = configured
    ? configured
    : [
        path.join(home, 'Library', 'Android', 'sdk'),
        path.join(home, 'Android', 'Sdk'),
        path.join(home, 'Android', 'sdk'),
        path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
      ].find((candidate) => fs.existsSync(path.join(candidate, 'platform-tools')));
  return sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb';
}

function connectedDeviceAbi(): string | null {
  try {
    const adb = adbPath();
    const serials = execFileSync(adb, ['devices'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([, state]) => state === 'device')
      .map(([serial]) => serial!);
    if (serials.length !== 1) return null;
    const abis = execFileSync(adb, ['-s', serials[0]!, 'shell', 'getprop', 'ro.product.cpu.abilist'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (
      abis
        .trim()
        .split(',')
        .find((abi) => ANDROID_ABIS.includes(abi)) ?? null
    );
  } catch {
    return null;
  }
}

function keyOptions(platform: string, runOptions: RunOptions = {}): RunOptions | null {
  // Expo `run:ios` targets a simulator on this Mac, so its app runs on this Mac's architecture. A Release
  // build still compiles every ARCHS value, a superset of the slice `stim ios` builds under the same key.
  // The generic destination keeps the unsuffixed key. `--device <name>` keys as on-<name> with no arch:
  // Expo's name cannot tell a simulator from a phone.
  if (platform === 'ios') {
    if (runOptions.arch || runOptions.device === 'generic') return runOptions;
    return { ...runOptions, arch: hostSimulatorArch() };
  }
  // Expo `run:android` builds a `debug` or `debugOptimized` build type without `--all-arch`
  // only for the ABI of the device it selected, and boots that device before asking the
  // provider for a build.
  if (platform !== 'android' || runOptions.abi || runOptions.allArch) return runOptions;
  const parts = (runOptions.variant || 'debug').split(/(?=[A-Z])/);
  let buildType = parts.pop()!;
  if (parts.length > 0 && buildType === 'Optimized') buildType = parts.pop()! + buildType;
  if (!/^debug(optimized)?$/i.test(buildType)) return runOptions;
  const abi = connectedDeviceAbi();
  return abi ? { ...runOptions, abi } : null;
}

function registerOnce(): void {
  const root = cacheRoot();
  if (registeredDir === root) return;
  registeredDir = root;
  registerCache({
    dir: root,
    name: 'Expo build cache',
    prune: 'entries',
    entriesDepth: 2,
    note: 'built .app/.apk keyed on the native fingerprint',
  });
}

export async function resolveBuildCache({
  platform,
  fingerprintHash,
  runOptions,
}: {
  platform: string;
  fingerprintHash: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
  registerOnce();
  const options = keyOptions(platform, runOptions);
  if (!options) {
    console.log(`[build-cache] skip ${platform}: cannot tell which ABI this debug build targets`);
    return null;
  }
  const key = buildCacheKey(platform, fingerprintHash, options);
  const hit = resolveArtifact(entryDir(platform, key));
  if (hit) {
    console.log(`[build-cache] hit ${platform} ${shortKey(key, fingerprintHash)}`);
    return hit;
  }
  console.log(`[build-cache] miss ${platform} ${shortKey(key, fingerprintHash)}`);
  return null;
}

export async function uploadBuildCache({
  platform,
  fingerprintHash,
  buildPath,
  runOptions,
  signal,
}: {
  platform: string;
  fingerprintHash: string;
  buildPath?: string;
  runOptions?: RunOptions;
  signal?: AbortSignal;
}): Promise<string | null> {
  signal?.throwIfAborted();
  registerOnce();
  if (!buildPath || !fs.existsSync(buildPath)) return null;

  const options = keyOptions(platform, runOptions);
  if (!options) {
    console.log(`[build-cache] skip ${platform}: cannot tell which ABI this debug build targets`);
    return null;
  }
  const key = buildCacheKey(platform, fingerprintHash, options);
  const dest = entryDir(platform, key);
  if (artifactIn(dest)) return artifactIn(dest);

  let stored: string | null;
  try {
    stored = await storeArtifactAsync(dest, buildPath, {
      ...(signal ? { signal } : {}),
      runFile: (file, args) =>
        new Promise<void>((resolve, reject) => {
          let failure: Error | null = null;
          const child = execFile(file, args, { signal }, (error) => {
            failure = error;
          });
          child.once('close', () => {
            if (failure) reject(failure);
            else resolve();
          });
        }),
      onRenameError: (staging) => fs.rmSync(staging, { recursive: true, force: true }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    console.warn(
      `[build-cache] could not store ${platform} ${shortKey(key, fingerprintHash)}: ${(error as Error).message}`,
    );
    return null;
  }
  if (stored) console.log(`[build-cache] stored ${platform} ${shortKey(key, fingerprintHash)}`);
  return stored;
}
