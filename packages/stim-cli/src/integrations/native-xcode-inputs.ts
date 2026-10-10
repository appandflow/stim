import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FingerprintSource } from '@expo/fingerprint';
import { fingerprintNativeInputs, NativeInputError, type NativeInputSnapshot } from './native-inputs.ts';
import { pbxReferences, pbxString, type NativeXcodeModel, type NativeXcodeSelection } from './native-xcode-project.ts';
import { workspaceDir, workspaceDerivedData } from '../workspace/paths.ts';

export function nativeXcodePackages(root: string): string {
  return join(workspaceDir(root), 'xcode-packages');
}

export function nativeXcodeMetadataDirectories(selection: NativeXcodeSelection): string[] {
  const workspaces = selection.projects.map((project) => join(project.path, 'project.xcworkspace'));
  if (selection.container.kind === 'workspace') workspaces.push(selection.container.path);
  return workspaces.flatMap((workspace) => [
    join(workspace, 'xcshareddata'),
    join(workspace, 'xcshareddata', 'swiftpm'),
    join(workspace, 'xcshareddata', 'swiftpm', 'configuration'),
  ]);
}

export function nativeXcodeHasPackages(selection: NativeXcodeSelection): boolean {
  return selection.projects.some((project) =>
    [...project.objects.values()].some(
      (entry) =>
        entry.isa === 'XCRemoteSwiftPackageReference' ||
        entry.isa === 'XCLocalSwiftPackageReference' ||
        entry.isa === 'XCSwiftPackageProductDependency',
    ),
  );
}

export function nativeXcodeSources(snapshot: NativeInputSnapshot): FingerprintSource[] {
  return snapshot.entries.map((entry) => ({
    type: 'contents',
    id: entry.path,
    contents: '',
    hash: createHash('sha256').update(`${entry.kind}\0${entry.sha256}`).digest('hex'),
    reasons: ['native-xcode'],
  }));
}

const INPUT_SETTINGS = new Set([
  'INFOPLIST_FILE',
  'CODE_SIGN_ENTITLEMENTS',
  'GCC_PREFIX_HEADER',
  'SWIFT_OBJC_BRIDGING_HEADER',
  'HEADER_SEARCH_PATHS',
  'USER_HEADER_SEARCH_PATHS',
  'MTL_HEADER_SEARCH_PATHS',
  'FRAMEWORK_SEARCH_PATHS',
  'LIBRARY_SEARCH_PATHS',
  'SWIFT_INCLUDE_PATHS',
  'PRODUCT_TYPE_SWIFT_INCLUDE_PATHS',
  'SWIFT_SYSTEM_INCLUDE_PATHS',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS',
  'ADDITIONAL_SDKS',

  'MODULEMAP_FILE',
  'MODULEMAP_PRIVATE_FILE',
  'EXPORTED_SYMBOLS_FILE',
  'UNEXPORTED_SYMBOLS_FILE',
  'ORDER_FILE',
]);

const COMPILER_SETTINGS = new Set(['CC', 'CXX', 'LD', 'SWIFT_EXEC', 'SWIFT_DRIVER_SWIFT_FRONTEND_EXEC']);

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

export function nativeXcodeInputSnapshot(
  root: string,
  selection: NativeXcodeSelection,
  parameters: { sdk: string; architecture: string | null; toolchain: Record<string, string>; optimizations: unknown },
  sourceRoot: string = root,
): NativeInputSnapshot | { cacheIneligible: string } {
  if (selection.platform === 'unknown')
    return { cacheIneligible: 'The selected application platform cannot be resolved from its project configuration' };
  const inputs: { name: string; path: string; optional?: boolean }[] = [{ name: 'repository', path: sourceRoot }];
  const excluded = [join(sourceRoot, '.git'), join(root, '.git'), workspaceDerivedData(root)];
  const reasons = new Set<string>();
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (
      value !== undefined &&
      /^(?:DEVELOPER_DIR|TOOLCHAINS|SDKROOT|CFLAGS|CPPFLAGS|CXXFLAGS|OBJCFLAGS|LDFLAGS|ARCHS|ONLY_ACTIVE_ARCH|SOURCE_DATE_EPOCH|ZERO_AR_DATE|IPHONEOS_DEPLOYMENT_TARGET|MACOSX_DEPLOYMENT_TARGET|DEVELOPMENT_TEAM|XCODE_.*|SWIFT_.*|CLANG_.*|GCC_.*|OTHER_.*FLAGS|CODE_SIGN.*|PROVISIONING_.*)$/.test(
        name,
      )
    )
      environment[name] = value;
  }
  const dependencyRoots = new Map<string, string>();
  const synchronizedRoots: string[] = [];
  const include = (path: string, name: string) => {
    if (!inside(sourceRoot, path)) dependencyRoots.set(name, path);
  };
  const expand = (value: string, project: NativeXcodeModel): string | null => {
    const known: Record<string, string> = {
      SRCROOT: project.directory,
      PROJECT_DIR: project.directory,
      SOURCE_ROOT: project.directory,
      PROJECT_FILE_PATH: project.path,
      CONFIGURATION: selection.configuration,
      inherited: '',
    };
    let missing = false;
    const result = value.replace(/\$\(([^)]+)\)|\$\{([^}]+)\}/g, (_match, parenthesized: string, braced: string) => {
      const name = parenthesized ?? braced;
      if (known[name] !== undefined) return known[name];
      const env = process.env[name];
      if (env !== undefined) {
        environment[name] = env;
        return env;
      }
      missing = true;
      return '';
    });
    if (missing || result.includes('$')) return null;
    return result;
  };
  const seenConfigs = new Set<string>();
  const xcconfig = (path: string, project: NativeXcodeModel) => {
    if (seenConfigs.has(path)) return;
    seenConfigs.add(path);
    include(path, `configuration:${relative(project.directory, path)}`);
    const source = readFileSync(path, 'utf8');
    for (const raw of source.split(/\r\n?|\n|\u2028|\u2029/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const match = line.match(/^#include(\?)?\s+"([^"]+)"\s*$/);
      if (match) {
        const name = expand(match[2]!, project);
        if (name === null) reasons.add(`Unresolved xcconfig include in ${path}`);
        else {
          const child = resolve(dirname(path), name);
          if (match[1] && !existsSync(child))
            inputs.push({ name: `optional-config:${relative(root, child)}`, path: child, optional: true });
          else xcconfig(child, project);
        }
      } else {
        const key = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*(?:\[[^\]]+\]\s*)*=/)?.[1];
        if (
          !key ||
          line.endsWith('\\') ||
          /\/\*|\*\//.test(line) ||
          /\$\(|\$\{|SEARCH_PATHS|OTHER_.*FLAGS|INFOPLIST_FILE|ENTITLEMENTS|BRIDGING_HEADER/.test(line) ||
          INPUT_SETTINGS.has(key) ||
          COMPILER_SETTINGS.has(key)
        )
          reasons.add(`xcconfig ${relative(root, path)} has build inputs that are not fully resolved`);
      }
    }
  };
  try {
    if (selection.schemeBuildScripts) reasons.add('Xcode scheme execution actions can consume undeclared inputs');
    for (const [projectIndex, project] of selection.projects.entries()) {
      include(project.directory, `referenced-project:${projectIndex}`);
      if (Array.isArray(project.project.projectReferences) && project.project.projectReferences.length)
        reasons.add('Referenced Xcode subprojects have no verified dependency input closure');
      excluded.push(join(project.path, 'xcuserdata'), join(project.path, 'project.xcworkspace', 'xcuserdata'));
      const visited = new Set<string>();
      const visit = (id: string, base: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const entry = project.objects.get(id);
        if (!entry) {
          reasons.add(`Missing Xcode file reference ${id}`);
          return;
        }
        const tree = pbxString(entry.sourceTree) ?? '<group>';
        const raw = pbxString(entry.path) ?? '';
        if (/\.(?:c|cc|cpp|cxx|m|mm|h|hh|hpp|hxx|metal)$/i.test(raw))
          reasons.add('C-family or Metal sources need a verified compiler include dependency graph');
        const value = expand(raw, project);
        if (value === null) {
          reasons.add(`Unresolved source path ${raw}`);
          return;
        }
        let path: string;
        if (tree === '<group>') path = resolve(base, value);
        else if (tree === 'SOURCE_ROOT') path = resolve(project.directory, value);
        else if (tree === '<absolute>' && isAbsolute(value)) path = value;
        else if (tree === 'SDKROOT' || tree === 'DEVELOPER_DIR' || tree === 'BUILT_PRODUCTS_DIR') return;
        else {
          reasons.add(`Unresolved source tree ${tree}`);
          return;
        }
        include(path, `reference:${projectIndex}:${id}`);
        if (entry.isa === 'PBXFileSystemSynchronizedRootGroup') {
          synchronizedRoots.push(
            inside(sourceRoot, path)
              ? ['repository', relative(sourceRoot, path).split(sep).join('/')].filter(Boolean).join('/')
              : `reference:${projectIndex}:${id}`,
          );
          if (
            Object.values((entry.explicitFileTypes ?? {}) as Record<string, unknown>).some((type) =>
              /^sourcecode\.(?:c|cpp|objective-c|metal)/.test(pbxString(type) ?? ''),
            )
          )
            reasons.add('C-family or Metal sources need a verified compiler include dependency graph');
        }
        if (path.endsWith('.xcconfig')) xcconfig(path, project);
        for (const child of pbxReferences(entry.children)) visit(child, path);
      };
      visit(pbxString(project.project.mainGroup) ?? '', project.directory);
      for (const [id, entry] of project.objects) {
        if (
          /^sourcecode\.(?:c|cpp|objective-c|metal)/.test(
            pbxString(entry.explicitFileType ?? entry.lastKnownFileType) ?? '',
          )
        )
          reasons.add('C-family or Metal sources need a verified compiler include dependency graph');
        if (entry.isa === 'PBXShellScriptBuildPhase' || entry.isa === 'PBXLegacyTarget' || entry.isa === 'PBXBuildRule')
          reasons.add(`Xcode ${entry.isa} ${pbxString(entry.name) ?? id} can consume undeclared inputs`);
        if (entry.isa === 'XCLocalSwiftPackageReference') {
          const name = pbxString(entry.relativePath);
          if (!name) reasons.add('A local Swift package has no readable path');
          else include(resolve(project.directory, name), `local-package:${projectIndex}:${id}`);
        }
        if (entry.isa === 'XCBuildConfiguration') {
          const base = pbxString(entry.baseConfigurationReference);
          if (base) visit(base, project.directory);
          const settings = entry.buildSettings;
          for (const [rawKey, setting] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
            if (rawKey.endsWith('_comment')) continue;
            const key = pbxString(rawKey)!;
            const values = Array.isArray(setting) ? pbxReferences(setting) : [setting];
            for (const [valueIndex, value] of values.entries()) {
              const text = pbxString(value);
              if (!text) continue;
              expand(text, project);
              if (COMPILER_SETTINGS.has(key.split('[')[0]!))
                reasons.add(`Custom compiler setting ${key} needs its own tool identity`);
              if (/^OTHER_.*FLAGS/.test(key) && /-I|-F|-L|\.\.|\//.test(text))
                reasons.add(`Unresolved external compiler flags in ${key}`);
              if (!INPUT_SETTINGS.has(key.split('[')[0]!)) continue;
              const expanded = expand(text, project);
              if (expanded === null || /["*]/.test(expanded) || (key.endsWith('SEARCH_PATHS') && /\s/.test(expanded))) {
                reasons.add(`Unresolved Xcode input setting ${key}`);
              } else
                include(resolve(project.directory, expanded), `setting:${projectIndex}:${id}:${key}:${valueIndex}`);
            }
          }
        }
      }
    }
    excluded.push(join(selection.container.path, 'xcuserdata'));
    for (const name of [
      'CPATH',
      'C_INCLUDE_PATH',
      'CPLUS_INCLUDE_PATH',
      'OBJC_INCLUDE_PATH',
      'OBJCPLUS_INCLUDE_PATH',
      'LIBRARY_PATH',
      'CC',
      'CXX',
      'LD',
      'SWIFT_EXEC',
      'SWIFT_DRIVER_SWIFT_FRONTEND_EXEC',
      'CCC_OVERRIDE_OPTIONS',
      'CLANG_CONFIG_FILE_USER_DIR',
      'CLANG_CONFIG_FILE_SYSTEM_DIR',
    ]) {
      if (process.env[name]) reasons.add(`Environment ${name} supplies native inputs outside the resolved project`);
    }
    if (process.env.XCODE_XCCONFIG_FILE) xcconfig(resolve(process.env.XCODE_XCCONFIG_FILE), selection.targetProject);
    for (const [name, value] of Object.entries(environment)) {
      if (
        /(?:FLAGS|OTHER_.*FLAGS)$/.test(name) &&
        /(?:[/@]|(?:^|\s)-(?:I|F|L|include|isystem|iquote|iframework|ivfsoverlay|fmodule|fplugin|resource-dir|sdk))/.test(
          value,
        )
      )
        reasons.add(`Environment ${name} supplies compiler inputs outside the resolved project`);
    }
    if (nativeXcodeHasPackages(selection)) {
      reasons.add('Swift package manifests, plugins and transitive local dependencies have no verified input closure');
    }
    if (reasons.size) return { cacheIneligible: [...reasons].join('; ') };
    for (const [name, path] of dependencyRoots) inputs.push({ name, path: realpathSync(path) });
    const snapshot = fingerprintNativeInputs(inputs, {
      excluded,
      ignoredDirectoryMarkers: nativeXcodeMetadataDirectories(selection),
      parameters: {
        recipe: 'native-xcode-v1',
        application: relative(sourceRoot, root),
        container: relative(root, selection.container.path),
        scheme: selection.scheme,
        target: selection.targetId,
        configuration: selection.configuration,
        ...parameters,
        environment,
      },
    });
    if (
      snapshot.entries.some(
        (entry) =>
          synchronizedRoots.some((prefix) => entry.path.startsWith(`${prefix}/`)) &&
          /\.(?:c|cc|cpp|cxx|m|mm|h|hh|hpp|hxx|metal)$/i.test(entry.path),
      )
    )
      return { cacheIneligible: 'C-family or Metal sources need a verified compiler include dependency graph' };
    return snapshot;
  } catch (error) {
    return {
      cacheIneligible:
        error instanceof NativeInputError
          ? error.message
          : `Native input closure is unavailable: ${(error as Error).message}`,
    };
  }
}
