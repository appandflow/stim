import { isAbsolute } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { PlatformRunOptions } from './protocol.ts';

const nativeText = ['slot', 'remoteBuild', 'remote', 'easProfile'];
const nativeBoolean = ['metroCheck', 'buildCache'];
const iosText = ['configuration', 'scheme', 'deviceType', 'runtime', 'simulatorApp'];
const androidText = ['variant', 'systemImage', 'deviceProfile'];

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function selector(value: unknown): string | boolean | undefined {
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

export function parsePlatformRun(params: unknown): { cwd: string; options: PlatformRunOptions } | null {
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
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') return null;
  const texts =
    platform === 'ios'
      ? [...nativeText, ...iosText]
      : platform === 'android'
        ? [...nativeText, ...androidText]
        : platform === 'macos'
          ? ['remote', 'remoteBuild']
          : [];
  const booleans = platform === 'ios' || platform === 'android' ? nativeBoolean : platform === 'web' ? ['headed'] : [];
  for (const [key, value] of Object.entries(options)) {
    if (key === 'platform') continue;
    if (
      texts.includes(key)
        ? !text(value)
        : booleans.includes(key)
          ? typeof value !== 'boolean'
          : (platform === 'ios' || platform === 'android') && (key === 'device' || key === 'wait')
            ? typeof value !== 'boolean' && !text(value)
            : true
    )
      return null;
  }
  if (platform === 'web') return { cwd, options: { platform, headed: optionalBoolean(options.headed) } };
  if (platform === 'macos')
    return {
      cwd,
      options: {
        platform,
        remote: optionalText(options.remote),
        remoteBuild: optionalText(options.remoteBuild),
      },
    };
  const native = {
    slot: optionalText(options.slot),
    metroCheck: optionalBoolean(options.metroCheck),
    buildCache: optionalBoolean(options.buildCache),
    remoteBuild: optionalText(options.remoteBuild),
    remote: optionalText(options.remote),
    easProfile: optionalText(options.easProfile),
    device: selector(options.device),
    wait: selector(options.wait),
  };
  return platform === 'ios'
    ? {
        cwd,
        options: {
          ...native,
          platform,
          configuration: optionalText(options.configuration),
          scheme: optionalText(options.scheme),
          deviceType: optionalText(options.deviceType),
          runtime: optionalText(options.runtime),
          simulatorApp: optionalText(options.simulatorApp),
        },
      }
    : {
        cwd,
        options: {
          ...native,
          platform,
          variant: optionalText(options.variant),
          systemImage: optionalText(options.systemImage),
          deviceProfile: optionalText(options.deviceProfile),
        },
      };
}
