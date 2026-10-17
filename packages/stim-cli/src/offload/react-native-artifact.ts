import { isDeepStrictEqual } from 'node:util';
import { reactNativeArtifactQuery, reactNativeArtifactIdentity } from '@stim-cli/core';
import type { BuildReactNativeArtifactQuery } from '@stim-cli/core/protocol';
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
  | Pick<WorkerToolchain, 'stimBuild' | 'os' | 'arch' | 'jdk' | 'androidSdk'>;

interface ArtifactReceipt {
  identity: { hash: string; key: string };
  receipt: { query: BuildReactNativeArtifactQuery; toolchain: ArtifactTools };
}

export async function reactNativeArtifactToolchain(
  platform: 'ios' | 'android',
  root: string,
): Promise<ArtifactTools | null> {
  if (platform === 'ios') {
    const tools = await iosToolchainAsync(root);
    return tools.stimBuild && tools.xcode && tools.simulatorSdk && tools.cocoapods
      ? { ...tools, os: process.platform }
      : null;
  }
  const { stimBuild, os, arch, jdk, androidSdk } = workerToolchain(null, 'gradle');
  return stimBuild && jdk && androidSdk ? { stimBuild, os, arch, jdk, androidSdk } : null;
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
