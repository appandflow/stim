import { isAbsolute } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { PlatformBuildOptions } from './protocol.ts';

export function parsePlatformBuild(params: unknown): { cwd: string; options: PlatformBuildOptions } | null {
  if (
    !isJsonObject(params) ||
    Object.keys(params).some((key) => key !== 'cwd' && key !== 'options') ||
    typeof params.cwd !== 'string' ||
    params.cwd.length > 4096 ||
    params.cwd.includes('\0') ||
    !isAbsolute(params.cwd) ||
    !isJsonObject(params.options)
  )
    return null;
  const { cwd, options } = params;
  const { platform } = options;
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos') return null;
  const texts =
    platform === 'ios'
      ? ['configuration', 'scheme', 'remoteBuild']
      : platform === 'android'
        ? ['variant', 'remoteBuild']
        : ['remoteBuild'];
  for (const [key, value] of Object.entries(options)) {
    if (key === 'platform' || (platform === 'ios' && key === 'arch') || (platform === 'android' && key === 'abi'))
      continue;
    if (
      texts.includes(key)
        ? typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')
        : platform !== 'macos' && key === 'buildCache'
          ? typeof value !== 'boolean'
          : true
    )
      return null;
  }
  const remoteBuild = typeof options.remoteBuild === 'string' ? options.remoteBuild : undefined;
  if (platform === 'macos') return { cwd, options: { platform, remoteBuild } };
  const buildCache = typeof options.buildCache === 'boolean' ? options.buildCache : undefined;
  if (platform === 'ios') {
    const { arch } = options;
    if (arch !== undefined && arch !== 'arm64' && arch !== 'x86_64' && arch !== 'all') return null;
    return {
      cwd,
      options: {
        platform,
        remoteBuild,
        buildCache,
        arch,
        configuration: typeof options.configuration === 'string' ? options.configuration : undefined,
        scheme: typeof options.scheme === 'string' ? options.scheme : undefined,
      },
    };
  }
  const { abi } = options;
  if (
    abi !== undefined &&
    abi !== 'arm64-v8a' &&
    abi !== 'armeabi-v7a' &&
    abi !== 'x86' &&
    abi !== 'x86_64' &&
    abi !== 'all'
  )
    return null;
  return {
    cwd,
    options: {
      platform,
      remoteBuild,
      buildCache,
      abi,
      variant: typeof options.variant === 'string' ? options.variant : undefined,
    },
  };
}
