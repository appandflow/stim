import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODE_BARE, MODE_EXPO } from '../supervisor/state.ts';
import type { ServerStarter } from '../supervisor/types.ts';
import {
  declaresAppDependency,
  detectIsExpo,
  isPackageResolvable,
  readAppConfigText,
  readAppJson,
  readPackageJson,
} from '../workspace/project.ts';
import { settingValueAt, webSettings, type SettingsObject } from '../workspace/settings.ts';

type ProjectPlatform = 'ios' | 'android' | 'macos' | 'web';

interface ProjectIntegration {
  platforms(root: string, settings: SettingsObject): ProjectPlatform[];
}

interface NativeProjectIntegration extends ProjectIntegration {
  mode: typeof MODE_BARE | typeof MODE_EXPO;
  loadDevServer(): Promise<ServerStarter>;
}

const expo: NativeProjectIntegration = {
  mode: MODE_EXPO,
  loadDevServer: async () => (await import('../supervisor/server-expo.ts')).startExpoServer,
  platforms(root) {
    const appJson = readAppJson(root);
    const config = appJson?.expo ?? appJson;
    const text = readAppConfigText(root);
    const explicit = (text ? literalPlatforms(text) : null) ?? config?.platforms;
    if (Array.isArray(explicit))
      return explicit.filter((platform) => platform === 'ios' || platform === 'android' || platform === 'web');
    const pkg = readPackageJson(root);
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    return [
      'ios',
      'android',
      ...('react-native-web' in deps || isPackageResolvable(root, 'react-native-web') ? (['web'] as const) : []),
    ];
  },
};

const reactNative: NativeProjectIntegration = {
  mode: MODE_BARE,
  loadDevServer: async () => (await import('../supervisor/server-bare.ts')).startBareServer,
  platforms(root) {
    if (!declaresAppDependency(readPackageJson(root))) return [];
    const platforms: ProjectPlatform[] = [];
    let ios: string[] = [];
    try {
      ios = readdirSync(join(root, 'ios'));
    } catch {}
    if (ios.some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))) platforms.push('ios');
    if (
      ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((name) =>
        existsSync(join(root, 'android', name)),
      )
    )
      platforms.push('android');
    return platforms;
  },
};

const swiftPackage: ProjectIntegration = {
  platforms(root, settings) {
    return existsSync(join(root, 'Package.swift')) &&
      settingValueAt(settings, 'macos.product') &&
      settingValueAt(settings, 'macos.infoPlist')
      ? ['macos']
      : [];
  },
};

const configuredWeb: ProjectIntegration = {
  platforms(_root, settings) {
    return webSettings(settings).url !== null ? ['web'] : [];
  },
};

export function nativeProjectIntegration(
  root: string,
  isExpo: (root: string) => boolean = detectIsExpo,
): NativeProjectIntegration {
  return isExpo(root) ? expo : reactNative;
}

export function detectPlatforms(root: string, settings: SettingsObject): ProjectPlatform[] {
  const integrations = [nativeProjectIntegration(root), swiftPackage, configuredWeb];
  const platforms = new Set(integrations.flatMap((integration) => integration.platforms(root, settings)));
  const ordered: ProjectPlatform[] = ['ios', 'android', 'macos', 'web'];
  return ordered.filter((platform) => platforms.has(platform));
}

function literalPlatforms(text: string): string[] | null {
  const tokens =
    text
      .match(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g,
      )
      ?.filter((token) => !token.startsWith('//') && !token.startsWith('/*')) ?? [];
  let open = 0;
  const index = tokens.findIndex((token, i) => {
    if (token === '[') open++;
    else if (token === ']') open--;
    return (
      open === 0 &&
      (token === 'platforms' || token === '"platforms"' || token === "'platforms'") &&
      tokens[i + 1] === ':'
    );
  });
  if (index < 0 || tokens[index + 2] !== '[') return null;
  const platforms: string[] = [];
  let i = index + 3;
  while (tokens[i] !== ']') {
    const value = tokens[i]?.match(/^(['"])([a-z]+)\1$/)?.[2];
    if (value === undefined) return null;
    platforms.push(value);
    i++;
    if (tokens[i] === ',') i++;
    else if (tokens[i] !== ']') return null;
  }
  return tokens[i + 1] === ',' || tokens[i + 1] === '}' ? platforms : null;
}
