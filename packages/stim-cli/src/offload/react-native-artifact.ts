import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reactNativeArtifactQuery, reactNativeArtifactIdentity } from '@stim-cli/core';
import type { BuildReactNativeArtifactQuery } from '@stim-cli/core/protocol';
import { getExecutor } from '../exec.ts';
import { BuildArtifactCache } from './build-artifact-cache.ts';
import { iosToolchainAsync, workerToolchain, type IosToolchain, type WorkerToolchain } from './toolchain.ts';

export function reactNativeBuildQuery(
  build: {
    platform: string;
    native?: unknown;
    isExpo?: boolean;
    runtime?: string | null;
    configuration?: string | null;
    scheme?: string | null;
    iosProjectPath?: string | null;
    optimizations?: unknown;
    android?: unknown;
  },
  fingerprint: string,
  project: string,
  toolchain: unknown,
): BuildReactNativeArtifactQuery | null {
  if (build.native) return null;
  return reactNativeArtifactQuery({
    project,
    fingerprint,
    toolchain,
    isExpo: build.isExpo === true,
    platform: build.platform,
    ...(build.platform === 'ios'
      ? {
          ios: {
            runtime: build.runtime,
            configuration: build.configuration ?? 'Debug',
            scheme: build.scheme ?? null,
            projectPath: build.iosProjectPath ?? 'ios',
            optimizations: build.optimizations,
          },
        }
      : { android: build.android }),
  });
}

type ArtifactTools =
  | (IosToolchain & { os: string })
  | (Pick<WorkerToolchain, 'stimBuild' | 'os' | 'arch' | 'jdk' | 'androidSdk'> & { compat: number });

interface ArtifactReceipt {
  identity: { hash: string; key: string };
  receipt: { query: BuildReactNativeArtifactQuery; toolchain: ArtifactTools };
}

export async function reactNativeArtifactToolchain(
  platform: 'ios' | 'android',
  root: string,
  iosDirectory: string,
): Promise<ArtifactTools | null> {
  if (platform === 'ios') {
    const tools = await iosToolchainAsync(root, iosDirectory);
    return tools.stimBuild && tools.xcode && tools.simulatorSdk && tools.cocoapods
      ? { ...tools, os: process.platform }
      : null;
  }
  const { stimBuild, compat, os, arch, jdk, androidSdk } = workerToolchain(null, 'gradle');
  return stimBuild && compat !== undefined && jdk && androidSdk
    ? { stimBuild, compat, os, arch, jdk, androidSdk }
    : null;
}

export function reactNativeArtifactReceipt(
  query: BuildReactNativeArtifactQuery,
  toolchain: ArtifactTools | null,
): ArtifactReceipt | null {
  if (!toolchain || !isDeepStrictEqual(reactNativeArtifactQuery({ ...query, toolchain })?.toolchain, query.toolchain))
    return null;
  const receipt = { query, toolchain };
  const identity = reactNativeArtifactIdentity(receipt);
  return { identity: { hash: identity.fingerprint, key: identity.cacheKey }, receipt };
}

/**
 * The development app stim-server retained for `query`, placed at `out/app.tgz` and unpacked beside it as a build
 * leaves it, when the client allows a reused artifact and `query` carries a fingerprint other than the one the client
 * looked up; null otherwise or on a miss.
 */
export async function reusedReactNativeArtifact(
  job: { artifactCache?: string; reuseArtifact?: boolean; expectedFingerprint: string | null },
  query: BuildReactNativeArtifactQuery,
  out: string,
  signal: AbortSignal,
): Promise<{ path: string; name: string; size: number; sha256: string } | null> {
  if (!job.reuseArtifact || !job.artifactCache || query.fingerprint === job.expectedFingerprint) return null;
  const cache = new BuildArtifactCache(job.artifactCache);
  const cached = await cache.lookupReactNative(query, signal);
  if (!cached) return null;
  await rm(out, { recursive: true, force: true });
  const fetched = await cache.fetch(cached, out, signal);
  if (!fetched) return null;
  const archive = join(out, 'app.tgz');
  await rename(fetched.path, archive);
  await getExecutor().runFileAsync('tar', ['-xf', archive, '-C', out], { timeoutMs: 600_000 });
  const { name, size, sha256 } = fetched.artifact;
  return { path: archive, name, size, sha256 };
}
