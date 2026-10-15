import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { storeArtifactAsync, type StimContext } from '@stim-cli/core';
import type { BuildCacheCapability } from '@stim-cli/cache';
import { artifactIn, cacheRoot, entryDir, resolveBuild } from '../cache/build-cache.ts';
import { register } from '../cache/cache-manifest.ts';
import { findBuildTool } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { runCancellationSignal } from '../engine/native-run.ts';

const RECEIPT = 'native-android.json';
async function digest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectApk(
  path: string,
  sdk: string,
  abi: string | null,
  operation?: StimContext,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!(await stat(path)).isFile()) throw new Error('The native APK is not a regular file.');
  const signer = findBuildTool(['apksigner'], { home: sdk });
  const aapt = findBuildTool(['aapt'], { home: sdk });
  if (!signer || !aapt) throw new Error('Android SDK apksigner and aapt are required to verify a cached native APK.');
  const before = await digest(path, signal);
  const options = { timeoutMs: 30_000, signal, declareFor: operation };
  const executor = getExecutor();
  const signature = await executor.runFileAsync(signer.path, ['verify', '--print-certs', path], options);
  const signers = [
    ...signature.matchAll(/^(?:Signer #\d+|V\d+(?:\.\d+)? Signer:) certificate SHA-256 digest: ([a-f\d]{64})\s*$/gim),
  ]
    .flatMap((match) => (match[1] ? [match[1].toLowerCase()] : []))
    .toSorted();
  if (!signers.length) throw new Error('The native APK has no verified signing certificate.');
  const badging = await executor.runFileAsync(aapt.path, ['dump', 'badging', path], options);
  const line = badging.split(/\r?\n/).find((value) => value.startsWith('package:'));
  const androidPackage = line?.match(/^package: name='([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)'/)?.[1];
  if (!line || !androidPackage || /\bsplit=/.test(line))
    throw new Error('The native APK is not a standalone Android package.');
  const native = badging.split(/\r?\n/).find((value) => value.startsWith('native-code:'));
  const abis = native
    ? [...native.matchAll(/'([^']+)'/g)].flatMap((match) => (match[1] ? [match[1]] : [])).toSorted()
    : [];
  if (abi && native && !abis.includes(abi)) throw new Error('The native APK does not contain the target ABI.');
  const sha256 = await digest(path, signal);
  if (sha256 !== before) throw new Error('The native APK changed during verification.');
  return { androidPackage, signers, abis, sha256 };
}

export async function materializeNativeApk(
  key: string,
  path: string,
  sdk: string,
  abi: string | null,
  operation?: StimContext,
): Promise<{ apkPath: string; directory: null; androidPackage: string } | null> {
  const signal = runCancellationSignal(operation) ?? operation?.signal ?? getExecutor().reportSignal?.();
  try {
    const receipt = JSON.parse(await readFile(join(dirname(path), RECEIPT), { encoding: 'utf8', signal }));
    if (receipt.schema !== 1 || receipt.key !== key || receipt.sha256 !== (await digest(path, signal))) return null;
    const actual = await inspectApk(path, sdk, abi, operation, signal);
    if (
      actual.sha256 !== receipt.sha256 ||
      actual.androidPackage !== receipt.androidPackage ||
      JSON.stringify(actual.signers) !== JSON.stringify(receipt.signers) ||
      JSON.stringify(actual.abis) !== JSON.stringify(receipt.abis)
    )
      return null;
    return { apkPath: path, directory: null, androidPackage: actual.androidPackage };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export function nativeAndroidCache(
  sdk: string,
  abi: string | null,
  androidPackage: () => string | null,
  operation?: StimContext,
): BuildCacheCapability {
  return {
    resolve: ({ key }) => resolveBuild('android', key),
    async store({ key, sourcePath, overwrite, signal }) {
      const actual = await inspectApk(sourcePath, sdk, abi, operation, signal);
      if (actual.androidPackage !== androidPackage())
        throw new Error('The APK package does not match the Gradle model.');
      register({
        dir: cacheRoot(),
        name: 'Build cache',
        prune: 'entries',
        entriesDepth: 2,
        note: 'built .app/.apk keyed on the native fingerprint',
      });
      return storeArtifactAsync(entryDir('android', key), sourcePath, {
        signal,
        overwrite,
        runFile: (file, args) =>
          getExecutor().runFileAsync(file, args, { timeoutMs: 120_000, signal, declareFor: operation }),
        async writeMetadata(staging) {
          if ((await digest(join(staging, basename(sourcePath)), signal)) !== actual.sha256)
            throw new Error('The native APK changed while it was copied.');
          await writeFile(join(staging, RECEIPT), JSON.stringify({ schema: 1, key, ...actual }), { signal });
        },
      });
    },
  };
}

export async function plannedNativeApk(
  key: string,
  sdk: string,
  abi: string | null,
  operation?: StimContext,
): Promise<boolean> {
  const path = artifactIn(entryDir('android', key));
  return path !== null && (await materializeNativeApk(key, path, sdk, abi, operation)) !== null;
}
