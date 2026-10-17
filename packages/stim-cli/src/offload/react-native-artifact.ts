import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { reactNativeArtifactQuery } from '@stim-cli/core';
import type { BuildReactNativeArtifactQuery } from '@stim-cli/core/protocol';
import { isJsonObject } from '@stim-cli/core/state';
import { fingerprintProject } from '../cache/build-cache.ts';
import { androidLayoutSetting } from '../workspace/settings.ts';
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

export async function reactNativeArtifactReceipt(
  query: BuildReactNativeArtifactQuery,
  root: string,
): Promise<ArtifactReceipt | null> {
  const toolchain = await reactNativeArtifactToolchain(query.platform, root);
  if (!toolchain || !isDeepStrictEqual(reactNativeArtifactQuery({ ...query, toolchain })?.toolchain, query.toolchain))
    return null;
  const receipt = { query, toolchain };
  const hash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  return { identity: { hash, key: `react-native-${query.platform}-${hash}` }, receipt };
}

export async function findReactNativeArtifact(
  root: string,
  query: BuildReactNativeArtifactQuery,
  receipt: unknown,
): Promise<{ hash: string; key: string } | null> {
  if (!isJsonObject(receipt) || !isDeepStrictEqual(receipt.query, query)) return null;
  const fingerprint = await fingerprintProject(
    root,
    query.platform === 'ios'
      ? { platform: 'ios', iosProjectPath: query.ios.projectPath }
      : {
          platform: 'android',
          androidLayout: androidLayoutSetting(
            {
              android: {
                gradleRoot: query.android.gradleRoot ?? undefined,
                module: query.android.module ?? undefined,
              },
            },
            root,
            root,
          ),
        },
  );
  if (fingerprint?.hash !== query.fingerprint) return null;
  const current = await reactNativeArtifactReceipt(query, root);
  return current && isDeepStrictEqual(receipt, current.receipt) ? current.identity : null;
}
