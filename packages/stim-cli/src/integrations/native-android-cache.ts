import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { storeArtifact } from '@stim-cli/core';
import type { BuildCacheCapability } from '@stim-cli/cache';
import { artifactIn, cacheRoot, entryDir, resolveBuild } from '../cache/build-cache.ts';
import { register } from '../cache/cache-manifest.ts';
import { findBuildTool } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';

const RECEIPT = 'native-android.json';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function inspectApk(path: string, sdk: string, abi: string | null) {
  if (!statSync(path).isFile()) throw new Error('The native APK is not a regular file.');
  const signer = findBuildTool(['apksigner'], { home: sdk });
  const aapt = findBuildTool(['aapt'], { home: sdk });
  if (!signer || !aapt) throw new Error('Android SDK apksigner and aapt are required to verify a cached native APK.');
  const executor = getExecutor();
  const signature = await executor.runFileAsync(signer.path, ['verify', '--print-certs', path], { timeoutMs: 30_000 });
  const signers = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})\s*$/gim)]
    .map((match) => match[1]!.toLowerCase())
    .toSorted();
  if (!signers.length) throw new Error('The native APK has no verified signing certificate.');
  const badging = await executor.runFileAsync(aapt.path, ['dump', 'badging', path], { timeoutMs: 30_000 });
  const line = badging.split(/\r?\n/).find((value) => value.startsWith('package:'));
  const androidPackage = line?.match(/^package: name='([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)'/)?.[1];
  if (!androidPackage || /\bsplit=/.test(line!)) throw new Error('The native APK is not a standalone Android package.');
  const native = badging.split(/\r?\n/).find((value) => value.startsWith('native-code:'));
  const abis = native ? [...native.matchAll(/'([^']+)'/g)].map((match) => match[1]!).toSorted() : [];
  if (abi && native && !abis.includes(abi)) throw new Error('The native APK does not contain the target ABI.');
  return { androidPackage, signers, abis, sha256: digest(path) };
}

export async function materializeNativeApk(
  key: string,
  path: string,
  sdk: string,
  abi: string | null,
): Promise<{ apkPath: string; directory: null; androidPackage: string } | null> {
  try {
    const receipt = JSON.parse(readFileSync(join(dirname(path), RECEIPT), 'utf8'));
    if (receipt.schema !== 1 || receipt.key !== key || receipt.sha256 !== digest(path)) return null;
    const actual = await inspectApk(path, sdk, abi);
    if (
      actual.androidPackage !== receipt.androidPackage ||
      JSON.stringify(actual.signers) !== JSON.stringify(receipt.signers) ||
      JSON.stringify(actual.abis) !== JSON.stringify(receipt.abis)
    )
      return null;
    return { apkPath: path, directory: null, androidPackage: actual.androidPackage };
  } catch {
    return null;
  }
}

export function nativeAndroidCache(
  sdk: string,
  abi: string | null,
  androidPackage: () => string | null,
): BuildCacheCapability {
  return {
    resolve: ({ key }) => resolveBuild('android', key),
    async store({ key, sourcePath, overwrite }) {
      const actual = await inspectApk(sourcePath, sdk, abi);
      if (actual.androidPackage !== androidPackage())
        throw new Error('The APK package does not match the Gradle model.');
      register({
        dir: cacheRoot(),
        name: 'Build cache',
        prune: 'entries',
        entriesDepth: 2,
        note: 'built .app/.apk keyed on the native fingerprint',
      });
      return storeArtifact(entryDir('android', key), sourcePath, {
        runFile: getExecutor().runFile,
        overwrite,
        writeMetadata(staging) {
          if (digest(join(staging, basename(sourcePath))) !== actual.sha256)
            throw new Error('The native APK changed while it was copied.');
          writeFileSync(join(staging, RECEIPT), JSON.stringify({ schema: 1, key, ...actual }));
        },
      });
    },
  };
}

export async function plannedNativeApk(key: string, sdk: string, abi: string | null): Promise<boolean> {
  const path = artifactIn(entryDir('android', key));
  return path !== null && (await materializeNativeApk(key, path, sdk, abi)) !== null;
}
