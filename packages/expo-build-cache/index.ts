import fs from 'node:fs';
import path from 'node:path';
import {
  artifactIn,
  buildCacheRoot,
  buildCacheKey,
  registerCache,
  resolveArtifact,
  storeArtifact,
} from '@stim-cli/core';
import type { BuildRunOptions as RunOptions } from '@stim-cli/core';

export { buildCacheKey };

let registeredDir: string | null = null;
import { execFileSync } from 'node:child_process';

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
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  return sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb';
}

function connectedDeviceAbi(): string | null {
  try {
    const adb = adbPath();
    const serials = execFileSync(adb, ['devices'], { encoding: 'utf8', timeout: 10_000 })
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([, state]) => state === 'device')
      .map(([serial]) => serial!);
    if (serials.length !== 1) return null;
    const abis = execFileSync(adb, ['-s', serials[0]!, 'shell', 'getprop', 'ro.product.cpu.abilist'], {
      encoding: 'utf8',
      timeout: 10_000,
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

// Expo `run:android` builds a debug variant without `--all-arch` only for the ABIs of the
// device it selected, and boots that device before asking the provider for a build.
function keyOptions(platform: string, runOptions: RunOptions = {}): RunOptions | null {
  if (platform !== 'android' || runOptions.abi || runOptions.allArch) return runOptions;
  const buildType = (runOptions.variant || 'debug')
    .split(/(?=[A-Z])/)
    .pop()!
    .toLowerCase();
  if (buildType !== 'debug') return runOptions;
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
}: {
  platform: string;
  fingerprintHash: string;
  buildPath?: string;
  runOptions?: RunOptions;
}): Promise<string | null> {
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
    stored = storeArtifact(dest, buildPath, {
      runFile: execFileSync,
      onRenameError: (staging) => fs.rmSync(staging, { recursive: true, force: true }),
    });
  } catch (error) {
    console.warn(
      `[build-cache] could not store ${platform} ${shortKey(key, fingerprintHash)}: ${(error as Error).message}`,
    );
    return null;
  }
  if (stored) console.log(`[build-cache] stored ${platform} ${shortKey(key, fingerprintHash)}`);
  return stored;
}
