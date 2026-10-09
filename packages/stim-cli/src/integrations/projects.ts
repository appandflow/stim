import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODE_BARE, MODE_EXPO } from '../supervisor/state.ts';
import type { ServerStarter } from '../supervisor/types.ts';
import {
  appProjectProblem,
  declaresAppDependency,
  loadPackageJson,
  detectIsExpo,
  isPackageResolvable,
  readAppConfigText,
  readAppJson,
  readPackageJson,
} from '../workspace/project-files.ts';
import { settingValueAt, webSettings, type SettingsObject } from '../workspace/settings.ts';
import { nativeXcodeProjectIntegration } from './native-xcode-project.ts';

import {
  createProjectRegistry,
  type ProjectIntegration,
  type ProjectPlatform,
  type ProjectRegistry,
} from './project-registry.ts';

interface NativeProjectIntegration {
  platforms(root: string, settings: SettingsObject): ProjectPlatform[];
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

const reactNativeProject: ProjectIntegration = {
  id: 'react-native',
  inspect(root) {
    const manifest = loadPackageJson(root);
    const problem = appProjectProblem(root, manifest);
    return {
      root: existsSync(join(root, 'package.json')) ? 'explicit' : false,
      application: problem === null,
      ownedRoots: problem === null ? [join(root, 'ios'), join(root, 'android')] : [],
      platforms: (settings) => nativeProjectIntegration(root).platforms(root, settings),
      validate: (operation) =>
        operation === 'ios' || operation === 'android' || operation === 'dev-server' ? problem : undefined,
      ios: async () => (await import('./react-native-ios.ts')).reactNativeIosProject(root),
      android: async () => (await import('./react-native-android.ts')).reactNativeAndroidProject(root),
      doctor: async () => (await import('./react-native-doctor.ts')).reactNativeProjectDoctor(root),
    };
  },
};

const swiftPackage: ProjectIntegration = {
  id: 'swift-package',
  inspect(root) {
    if (!existsSync(join(root, 'Package.swift'))) return null;
    return {
      root: 'explicit',
      application: true,
      platforms: (settings) =>
        settingValueAt(settings, 'macos.product') && settingValueAt(settings, 'macos.infoPlist') ? ['macos'] : [],
      validate: (operation) => (operation === 'macos' ? null : undefined),
      macos: async () => (await import('./swiftpm-macos.ts')).swiftpmMacosProject(root),
      doctor: async () => {
        const { macosToolchain } = await import('../offload/toolchain.ts');
        return {
          inspect: () => [],
          offloadTargets: ({ options: { host = process.platform, platform } }) =>
            host === 'darwin' && platform === undefined ? () => [{ platform: 'macos', local: macosToolchain() }] : null,
        };
      },
    };
  },
};

const browserWeb: ProjectIntegration = {
  id: 'browser-web',
  inspect(root) {
    return {
      root: false,
      application: false,
      platforms: (settings) => (webSettings(settings).url !== null ? ['web'] : []),
      validate: (operation) => (operation === 'web' ? null : undefined),
      web: async () => (await import('./browser-web.ts')).browserWebProject(root),
    };
  },
};

export const projectIntegrations: readonly ProjectIntegration[] = [
  reactNativeProject,
  swiftPackage,
  browserWeb,
  nativeXcodeProjectIntegration,
];
export const projectRegistry: ProjectRegistry = createProjectRegistry(projectIntegrations);
export const detectPlatforms: ProjectRegistry['detectPlatforms'] = projectRegistry.detectPlatforms;

export function nativeProjectIntegration(
  root: string,
  isExpo: (root: string) => boolean = detectIsExpo,
): NativeProjectIntegration {
  return isExpo(root) ? expo : reactNative;
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
