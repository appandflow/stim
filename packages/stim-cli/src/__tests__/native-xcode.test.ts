import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as xcode from '../engine/xcode.ts';
import { buildIosOperation } from '../commands/ios/build.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { nativeXcodeInputSnapshot } from '../integrations/native-xcode-inputs.ts';
import { nativeXcodeDoctor, nativeXcodeIosProject } from '../integrations/native-xcode-ios.ts';
import { IosRecipeRefusal, type IosArtifactContext } from '../integrations/ios-project.ts';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { resolveOptimizations } from '../optimizations.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';

function unresolvedSettings(root: string) {
  return { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} };
}

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-xcode-')));
  home = mkdtempSync(join(tmpdir(), 'stim-native-xcode-home-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function write(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function fingerprint() {
  return nativeXcodeInputSnapshot(root, selectNativeXcodeProject(root), {
    sdk: 'iphonesimulator',
    architecture: 'arm64',
    toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
    optimizations: resolveOptimizations({}, {}).ios,
  });
}

test.each(['xcshareddata', 'xcshareddata/swiftpm', 'xcshareddata/swiftpm/configuration'])(
  'Xcode metadata directory %s does not change identity but its files do',
  (path) => {
    const project = writeNativeXcodeProject(root);
    const workspace = join(project, 'project.xcworkspace');
    mkdirSync(workspace);
    const before = fingerprint();
    expect(before).toHaveProperty('hash');
    const directory = join(workspace, path);
    mkdirSync(directory, { recursive: true });
    expect(fingerprint()).toEqual(before);
    const file = join(directory, 'input.json');
    write(file, 'first');
    const populated = fingerprint();
    expect(populated).not.toEqual(before);
    write(file, 'edited');
    expect(fingerprint()).not.toEqual(populated);
    rmSync(file);
    expect(fingerprint()).toEqual(before);
    rmSync(directory, { recursive: true });
    write(directory, 'a file in place of the directory');
    expect(fingerprint()).not.toEqual(before);
  },
);

test.skipIf(process.platform === 'win32')('links cannot masquerade as ignored Xcode directory markers', () => {
  const project = writeNativeXcodeProject(root);
  const workspace = join(project, 'project.xcworkspace');
  mkdirSync(workspace);
  const before = fingerprint();
  symlinkSync('../xcshareddata', join(workspace, 'xcshareddata'));
  expect(fingerprint()).not.toEqual(before);
});

test('ordinary empty source directories remain part of the native identity', () => {
  writeNativeXcodeProject(root);
  const before = fingerprint();
  mkdirSync(join(root, 'Assets', 'xcshareddata', 'swiftpm', 'configuration'), { recursive: true });
  expect(fingerprint()).not.toEqual(before);
});

function configuredProject(projectBase: string, projectInline = '', targetBase = '', targetInline = '') {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace(
        'PROJECT = { isa = PBXProject; mainGroup = GROUP; buildConfigurationList = CONFIGURATIONS;',
        'PROJECT = { isa = PBXProject; mainGroup = GROUP; buildConfigurationList = PROJECT_CONFIGURATIONS;',
      )
      .replace('children = ( SOURCE, );', 'children = ( SOURCE, CONFIG_GROUP, );')
      .replaceAll('SDKROOT = iphoneos;', targetInline)
      .replaceAll(
        'isa = XCBuildConfiguration;',
        'isa = XCBuildConfiguration; baseConfigurationReference = TARGET_CONFIG;',
      )
      .replace(
        'objects = {',
        `objects = {
CONFIG_GROUP = { isa = PBXGroup; path = Configs; children = ( PROJECT_CONFIG, TARGET_CONFIG, ); sourceTree = "<group>"; };
PROJECT_CONFIG = { isa = PBXFileReference; path = Project.xcconfig; sourceTree = "<group>"; };
TARGET_CONFIG = { isa = PBXFileReference; path = Target.xcconfig; sourceTree = "<group>"; };
PROJECT_CONFIGURATIONS = { isa = XCConfigurationList; buildConfigurations = ( PROJECT_DEBUG, PROJECT_RELEASE, PROJECT_CUSTOM, ); };
${['Debug', 'Release', 'Staging'].map((name, index) => `${['PROJECT_DEBUG', 'PROJECT_RELEASE', 'PROJECT_CUSTOM'][index]} = { isa = XCBuildConfiguration; name = ${name}; baseConfigurationReference = PROJECT_CONFIG; buildSettings = { ${projectInline} }; };`).join('\n')}`,
      ),
  );
  write(join(root, 'Configs', 'Project.xcconfig'), projectBase);
  write(join(root, 'Configs', 'Target.xcconfig'), targetBase);
  return file;
}

test.each([
  'SDKROOT = "iphoneos"',
  'SUPPORTED_PLATFORMS = iphoneos iphonesimulator',
  'IPHONEOS_DEPLOYMENT_TARGET = 18.0',
])('base xcconfig platform declaration %s admits the native app without executing tools', (platform) => {
  configuredProject('#include "Shared.xcconfig"\n#include? "Optional.xcconfig"\nSWIFT_VERSION = 5.0\n');
  write(join(root, 'Configs', 'Shared.xcconfig'), `${platform}\n`);
  setExecutor(
    makeExecutor({
      runFile: () => {
        throw new Error('Discovery cannot execute tools');
      },
    }),
  );
  expect(projectRegistry.findProjectRoot(root)).toBe(root);
  expect(projectRegistry.detectPlatforms(root, {})).toEqual(['ios']);
  for (const configuration of ['Debug', 'Release', 'Staging']) {
    expect(selectNativeXcodeProject(root, undefined, configuration).platform).toBe('ios');
  }
  expect(fingerprint()).toHaveProperty('hash');
});

test.each([
  ['SDKROOT = iphoneos', '', '', '', true],
  ['SDKROOT = iphoneos', 'SDKROOT = macosx;', '', '', false],
  ['SDKROOT = macosx', 'SDKROOT = macosx;', 'SDKROOT = iphoneos', '', true],
  ['SDKROOT = iphoneos', '', 'SDKROOT = iphoneos', 'SDKROOT = macosx;', false],
] as const)(
  'platform selection follows project config, project inline, target config and target inline precedence (%s / %s / %s / %s)',
  (projectBase, projectInline, targetBase, targetInline, ios) => {
    configuredProject(projectBase, projectInline, targetBase, targetInline);
    expect(projectRegistry.detectPlatforms(root, {})).toEqual(ios ? ['ios'] : []);
  },
);

test.each([
  'SDKROOT = $(APP_SDK)',
  'SDKROOT[sdk=iphoneos*] = iphoneos\nSDKROOT = macosx',
  '#include "$(CONFIG_DIR)/Base.xcconfig"',
  '',
])(
  'unresolved platform configuration remains a candidate but cannot claim a cache key or plan (%s)',
  async (configuration) => {
    configuredProject(configuration);
    expect(projectRegistry.findProjectRoot(root)).toBe(root);
    expect(selectNativeXcodeProject(root).platform).toBe('unknown');
    expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('application platform') });
    setExecutor(
      makeExecutor({
        runFile: () => 'Tool identity',
        spawn: () => {
          throw new Error('Planning cannot spawn');
        },
      }),
    );
    expect(await nativeXcodeIosProject(root).plan!({}, unresolvedSettings(root))).toMatchObject({
      refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('application platform') },
    });
  },
);

test.each([
  'SWIFT_INCLUDE_PATHS',
  'PRODUCT_TYPE_SWIFT_INCLUDE_PATHS',
  'SWIFT_SYSTEM_INCLUDE_PATHS',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS',
  'ADDITIONAL_SDKS',
  'CC',
  'CXX',
  'LD',
  'SWIFT_EXEC',
  'SWIFT_DRIVER_SWIFT_FRONTEND_EXEC',
  'CC[sdk=iphoneos*]',
  'EXPORTED_SYMBOLS_FILE',
  'UNEXPORTED_SYMBOLS_FILE',
  'ORDER_FILE',
])('literal xcconfig %s cannot reuse artifacts without a verified external input closure', (setting) => {
  const external = join(home, 'external', setting === 'SWIFT_INCLUDE_PATHS' ? 'modules' : 'input');
  const input = setting === 'SWIFT_INCLUDE_PATHS' ? join(external, 'External.swiftmodule') : external;
  write(input, 'first external compiler/module bytes');
  configuredProject(`SDKROOT = iphoneos\n${setting} = ${external}\n`, '', '', 'SDKROOT = iphoneos;');
  expect(fingerprint()).toHaveProperty('cacheIneligible');
  write(input, 'changed external compiler/module bytes');
  expect(fingerprint()).toHaveProperty('cacheIneligible');
});

test.each(['EXPORTED_SYMBOLS_FILE', 'UNEXPORTED_SYMBOLS_FILE', 'ORDER_FILE'])(
  'external %s bytes invalidate the native artifact identity',
  (setting) => {
    const project = writeNativeXcodeProject(root);
    const file = join(project, 'project.pbxproj');
    const symbols = join(home, 'external', 'Symbols.txt');
    write(symbols, '_first\n');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'SDKROOT = iphoneos;',
        `SDKROOT = iphoneos; ${setting} = ${JSON.stringify(symbols)};`,
      ),
    );
    const before = fingerprint();
    expect(before).toHaveProperty('hash');
    write(symbols, '_second\n');
    expect(fingerprint()).not.toEqual(before);
  },
);

test.each([
  'SWIFT_INCLUDE_PATHS',
  'PRODUCT_TYPE_SWIFT_INCLUDE_PATHS',
  'SWIFT_SYSTEM_INCLUDE_PATHS',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS',
  'ADDITIONAL_SDKS',
])('every external directory in a commented %s array contributes to the artifact identity', (setting) => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  const directories = [join(home, 'first-modules'), join(home, 'second-modules')];
  for (const directory of directories) write(join(directory, 'External.swiftmodule'), 'first module bytes');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'SDKROOT = iphoneos;',
      `SDKROOT = iphoneos; ${setting} = (${directories.map((directory) => `${JSON.stringify(directory)} /* external input */`).join(', ')},);`,
    ),
  );
  const before = fingerprint();
  expect(before).toHaveProperty('hash');
  write(join(directories[0]!, 'External.swiftmodule'), 'changed first directory module bytes');
  const first = fingerprint();
  expect(first).not.toEqual(before);
  write(join(directories[1]!, 'External.swiftmodule'), 'changed second directory module bytes');
  expect(fingerprint()).not.toEqual(first);
});

test('quoted conditional compiler keys and parser comment metadata cannot bypass tool identity', () => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  const compiler = join(home, 'external', 'swiftc');
  write(compiler, 'first compiler bytes');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'SDKROOT = iphoneos;',
      `SDKROOT = iphoneos; "SWIFT_EXEC[sdk=iphonesimulator*]" /* compiler override */ = ${JSON.stringify(compiler)};`,
    ),
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('Custom compiler setting') });
  write(compiler, 'changed compiler bytes');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('Custom compiler setting') });
});

test('quoted conditional Swift module paths inventory external bytes despite parser comment metadata', () => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  const modules = join(home, 'external', 'modules');
  write(join(modules, 'External.swiftmodule'), 'first module bytes');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'SDKROOT = iphoneos;',
      `SDKROOT = iphoneos; "SWIFT_INCLUDE_PATHS[sdk=iphonesimulator*]" /* external modules */ = ${JSON.stringify(modules)};`,
    ),
  );
  const before = fingerprint();
  expect(before).toHaveProperty('hash');
  write(join(modules, 'External.swiftmodule'), 'changed module bytes');
  expect(fingerprint()).not.toEqual(before);
});

test('quoted conditional platform keys retain uncertainty instead of claiming an iOS cache identity', () => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'SDKROOT = iphoneos;',
      'SDKROOT = iphoneos; "SDKROOT[sdk=macosx*]" /* alternate platform */ = macosx;',
    ),
  );
  expect(selectNativeXcodeProject(root).platform).toBe('unknown');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('application platform') });
});

test('unparsed includes in a framework dependency configuration cannot authorize artifact reuse', () => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  const compiler = join(home, 'tool', 'swiftc');
  const externalConfig = join(home, 'Compiler.xcconfig');
  write(compiler, 'first compiler bytes');
  write(externalConfig, `SWIFT_EXEC = ${compiler}\n`);
  write(join(root, 'Framework.xcconfig'), `SWIFT_VERSION = 5.0\r# include "${externalConfig}"\r`);
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('children = ( SOURCE, );', 'children = ( SOURCE, FRAMEWORK_BASE, );')
      .replace('targets = ( APP, );', 'targets = ( APP, FRAMEWORK, );')
      .replace('name = Native; productType', 'name = Native; dependencies = ( FRAMEWORK_DEPENDENCY, ); productType')
      .replace(
        'objects = {',
        `objects = {
FRAMEWORK = { isa = PBXNativeTarget; name = Helper; productType = "com.apple.product-type.framework"; buildConfigurationList = FRAMEWORK_CONFIGURATIONS; };
FRAMEWORK_DEPENDENCY = { isa = PBXTargetDependency; target = FRAMEWORK; };
FRAMEWORK_CONFIGURATIONS = { isa = XCConfigurationList; buildConfigurations = ( FRAMEWORK_DEBUG, ); };
FRAMEWORK_DEBUG = { isa = XCBuildConfiguration; name = Debug; baseConfigurationReference = FRAMEWORK_BASE; buildSettings = { SDKROOT = iphoneos; }; };
FRAMEWORK_BASE = { isa = PBXFileReference; path = Framework.xcconfig; sourceTree = "<group>"; };`,
      ),
  );
  expect(selectNativeXcodeProject(root).platform).toBe('ios');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('xcconfig') });
  write(compiler, 'changed compiler bytes');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('xcconfig') });
});

test('Metal includes outside the repository cannot reuse a stale native artifact', () => {
  const external = join(home, 'shader-headers');
  write(join(external, 'Tone.h'), '#define TONE 1\n');
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('children = ( SOURCE, );', 'children = ( SOURCE, SHADER, );')
      .replaceAll('SDKROOT = iphoneos;', `SDKROOT = iphoneos; MTL_HEADER_SEARCH_PATHS = ${JSON.stringify(external)};`)
      .replace('name = Native; productType', 'name = Native; buildPhases = ( SOURCES, ); productType')
      .replace(
        'objects = {',
        `objects = {
SHADER = { isa = PBXFileReference; path = Shader.metal; lastKnownFileType = sourcecode.metal; sourceTree = "<group>"; };
SHADER_BUILD = { isa = PBXBuildFile; fileRef = SHADER; };
SOURCES = { isa = PBXSourcesBuildPhase; files = ( SHADER_BUILD, ); };`,
      ),
  );
  write(join(root, 'Shader.metal'), '#include "Tone.h"\nconstant int tone = TONE;\n');
  expect(fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('compiler include dependency graph'),
  });
  write(join(external, 'Tone.h'), '#define TONE 2\n');
  expect(fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('compiler include dependency graph'),
  });
});

test('native discovery accepts compact OpenStep arrays and preserves quoted and variable parentheses', () => {
  const project = writeNativeXcodeProject(root);
  const file = join(project, 'project.pbxproj');
  const source = readFileSync(file, 'utf8')
    .replaceAll(', );', ');')
    .replace(
      'SDKROOT = iphoneos;',
      `SDKROOT = iphoneos;
      OTHER_SWIFT_FLAGS = ($(inherited), "-D(SAFE)");
      PRODUCT_NAME = $(PRODUCT_$(CONFIGURATION));
      COMMENTED = (one /* ) */, two);`,
    );
  writeFileSync(file, source);
  const selection = selectNativeXcodeProject(root);
  expect(selection).toMatchObject({ scheme: 'Native', targetName: 'Native' });
  expect(selection.settings).toMatchObject({
    OTHER_SWIFT_FLAGS: ['$(inherited)', '"-D(SAFE)"'],
    PRODUCT_NAME: '$(PRODUCT_$(CONFIGURATION))',
    COMMENTED: [{ value: 'one', comment: ')' }, 'two'],
  });
  expect(readFileSync(file, 'utf8')).toBe(source);
});

test('production discovery selects a native application without Node or Metro and exposes each build configuration', async () => {
  writeNativeXcodeProject(root);
  setExecutor(
    makeExecutor({
      runFile: () => {
        throw new Error('Discovery must not launch an external tool');
      },
    }),
  );
  expect(projectRegistry.findProjectRoot(root)).toBe(root);
  expect(projectRegistry.detectPlatforms(root, {})).toEqual(['ios']);
  expect(projectRegistry.projectProblem(root, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(root, 'dev-server')?.kind).toBe('not-an-app');
  for (const configuration of ['Debug', 'Release', 'Staging']) {
    const selected = selectNativeXcodeProject(root, undefined, configuration);
    expect(selected).toMatchObject({ scheme: 'Native', targetName: 'Native', configuration });
    const runtime = nativeXcodeIosProject(root).runtime({
      configuration,
      prepareMetro: async () => {
        throw new Error('Metro must not be prepared');
      },
      prepareEmbedded: async () => {
        throw new Error('JS must not be embedded');
      },
    });
    expect(runtime.kind).toBe('process');
    expect(await runtime.prepare()).toEqual({ ok: true, prepared: { metroPort: null } });
  }
  expect(nativeXcodeIosProject(root).schemeProblem(undefined, 'Missing')?.code).toBe('STIM_BAD_ARG');
});

test('a workspace owns its referenced project instead of competing with it', () => {
  writeNativeXcodeProject(root);
  write(
    join(root, 'Native.xcworkspace', 'contents.xcworkspacedata'),
    '<Workspace><FileRef location="group:Native.xcodeproj" /></Workspace>',
  );
  expect(selectNativeXcodeProject(root)).toMatchObject({
    container: { flag: '-workspace', path: join(root, 'Native.xcworkspace') },
    scheme: 'Native',
  });
});

test('several application containers require an exact scheme and a missing scheme never guesses', () => {
  writeNativeXcodeProject(root);
  writeNativeXcodeProject(root, 'Another');
  expect(() => selectNativeXcodeProject(root)).toThrow('ambiguous');
  expect(selectNativeXcodeProject(root, 'Another').targetName).toBe('Another');
  expect(() => selectNativeXcodeProject(root, 'Missing')).toThrow('No runnable');
});

test('macOS applications and libraries do not become runnable iOS projects', () => {
  writeNativeXcodeProject(root, 'Desktop', 'macosx');
  writeNativeXcodeProject(root, 'Library', 'iphoneos', 'framework');
  expect(projectRegistry.projectProblem(root, 'ios')?.kind).toBe('not-an-app');
  expect(projectRegistry.detectPlatforms(root, {})).toEqual([]);
});

test('an unreadable native project refuses and a valid RN app retains ownership of its generated child', () => {
  const ios = join(root, 'ios');
  mkdirSync(ios);
  const project = writeNativeXcodeProject(ios);
  writeFileSync(join(project, 'project.pbxproj'), 'broken project');
  expect(projectRegistry.projectProblem(ios, 'ios')?.kind).toBe('unreadable');
  write(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  expect(projectRegistry.findProjectRoot(ios)).toBe(root);
  expect(projectRegistry.projectProblem(root, 'ios')).toBeNull();
});

test('source, ignored resources and build settings invalidate native reuse', () => {
  const project = writeNativeXcodeProject(root);
  write(join(root, '.gitignore'), 'Assets/ignored.bin\n');
  write(join(root, 'Assets', 'ignored.bin'), 'one');
  const before = fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  write(join(root, 'Assets', 'ignored.bin'), 'two');
  const asset = fingerprint();
  expect(asset).not.toEqual(before);
  write(join(root, 'Native.swift'), 'struct DifferentApp {}');
  const source = fingerprint();
  expect(source).not.toEqual(asset);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replaceAll('org.example.Native', 'org.example.Other'));
  expect(fingerprint()).not.toEqual(source);
});

test('a git checkout ignores ignored content and nested worktrees but keeps ignored files the project references', () => {
  const project = writeNativeXcodeProject(root);
  write(join(root, '.gitignore'), 'ignored/\nSecrets.plist\n');
  write(join(root, 'Secrets.plist'), 'one');
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8')
      .replace('children = ( SOURCE, );', 'children = ( SOURCE, SECRETS, );')
      .replace(
        'objects = {',
        'objects = {\nSECRETS = { isa = PBXFileReference; path = Secrets.plist; sourceTree = "<group>"; };',
      ),
  );
  const git = (...args: string[]) =>
    getExecutor().runFile('git', [
      '-C',
      root,
      '-c',
      'user.name=Stim',
      '-c',
      'user.email=stim@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const before = fingerprint();
  expect(before).toHaveProperty('hash');
  write(join(root, 'ignored', 'cache.bin'), 'generated');
  symlinkSync(join(root, 'missing'), join(root, 'ignored', 'dangling'));
  git('worktree', 'add', '-q', '--detach', join(root, 'nested'));
  expect(fingerprint()).toEqual(before);
  write(join(root, 'Secrets.plist'), 'two');
  const referenced = fingerprint();
  expect(referenced).not.toEqual(before);
  write(join(root, 'Untracked.swift'), 'struct Untracked {}');
  expect(fingerprint()).not.toEqual(referenced);
});

test('a git checkout keeps files whose on-disk names differ from the index in case or Unicode normalization', () => {
  writeNativeXcodeProject(root);
  write(join(root, 'helper.swift'), 'struct Helper {}');
  const decomposed = 'Cafe\u0301';
  write(join(root, decomposed, 'Menu.swift'), 'struct Menu {}');
  const git = (...args: string[]) =>
    getExecutor().runFile('git', [
      '-C',
      root,
      '-c',
      'user.name=Stim',
      '-c',
      'user.email=stim@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
  git('init', '-q');
  git('config', 'core.ignorecase', 'true');
  git('config', 'core.precomposeunicode', 'true');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  rmSync(join(root, 'helper.swift'));
  write(join(root, 'Helper.swift'), 'struct Helper {}');
  const before = fingerprint();
  expect(before).toHaveProperty('hash');
  write(join(root, 'Helper.swift'), 'struct HelperChanged {}');
  const renamed = fingerprint();
  expect(renamed).not.toEqual(before);
  write(join(root, decomposed, 'Menu.swift'), 'struct MenuChanged {}');
  expect(fingerprint()).not.toEqual(renamed);
});

test('a referenced source outside the application participates in native identity', () => {
  const app = join(root, 'App');
  mkdirSync(app);
  const project = writeNativeXcodeProject(app);
  const external = join(root, 'External.swift');
  writeFileSync(external, 'struct External {}');
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replace('path = Native.swift;', 'path = ../External.swift;'));
  const snapshot = () =>
    nativeXcodeInputSnapshot(app, selectNativeXcodeProject(app), {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: {},
      optimizations: {},
    });
  const before = snapshot();
  expect(before).not.toHaveProperty('cacheIneligible');
  writeFileSync(external, 'struct ExternalChanged {}');
  expect(snapshot()).not.toEqual(before);
});

test('repository inputs outside the application and unresolved C-family include graphs cannot produce stale hits', () => {
  const app = join(root, 'App');
  mkdirSync(app);
  const project = writeNativeXcodeProject(app);
  write(join(root, 'Shared', 'Resource.bin'), 'one');
  const snapshot = () =>
    nativeXcodeInputSnapshot(
      app,
      selectNativeXcodeProject(app),
      {
        sdk: 'iphonesimulator',
        architecture: 'arm64',
        toolchain: {},
        optimizations: {},
      },
      root,
    );
  const before = snapshot();
  expect(before).not.toHaveProperty('cacheIneligible');
  write(join(root, 'Shared', 'Resource.bin'), 'two');
  expect(snapshot()).not.toEqual(before);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(pbx, readFileSync(pbx, 'utf8').replace('path = Native.swift;', 'path = Native.m;'));
  write(join(app, 'Native.m'), '#include "../../Outside.h"\n');
  expect(snapshot()).toMatchObject({ cacheIneligible: expect.stringContaining('compiler include dependency graph') });
});

test('an unbounded build script is explicitly cache-ineligible rather than assigned an artifact key', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nSCRIPT = { isa = PBXShellScriptBuildPhase; shellScript = "date > generated.swift"; };',
    ),
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('undeclared inputs') });
});

test.each(['m', 'metal'])(
  'synchronized source groups inventory their files and refuse unresolved %s includes',
  (extension) => {
    const project = writeNativeXcodeProject(root);
    const pbx = join(project, 'project.pbxproj');
    writeFileSync(
      pbx,
      readFileSync(pbx, 'utf8').replace(
        'GROUP = { isa = PBXGroup; children = ( SOURCE, ); sourceTree = "<group>"; };',
        'GROUP = { isa = PBXFileSystemSynchronizedRootGroup; path = Sources; sourceTree = "<group>"; };',
      ),
    );
    write(join(root, 'Sources', 'App.swift'), 'struct NativeApp {}');
    const before = fingerprint();
    expect(before).not.toHaveProperty('cacheIneligible');
    write(join(root, 'Sources', 'App.swift'), 'struct UpdatedApp {}');
    expect(fingerprint()).not.toEqual(before);
    write(join(root, 'Sources', `Native.${extension}`), '#include "/external/input.h"\n');
    expect(fingerprint()).toMatchObject({
      cacheIneligible: expect.stringContaining('compiler include dependency graph'),
    });
  },
);

test('scheme execution actions cannot be skipped by an artifact cache hit', () => {
  const project = writeNativeXcodeProject(root);
  const scheme = join(project, 'xcshareddata', 'xcschemes', 'Native.xcscheme');
  writeFileSync(
    scheme,
    readFileSync(scheme, 'utf8').replace(
      '</Scheme>',
      '<BuildAction><PreActions><ExecutionAction ActionType="Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction"><ActionContent scriptText="date > generated.swift" /></ExecutionAction></PreActions></BuildAction></Scheme>',
    ),
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('scheme execution actions') });
});

test('relocation, shell location and task metadata preserve warm identities while compiler environment changes do not', () => {
  writeNativeXcodeProject(root);
  const before = fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  for (const name of ['PWD', 'OLDPWD', 'TMPDIR', 'SHLVL', '_', 'STIM_QA_TASK_ID', 'LANG', 'LC_ALL'])
    vi.stubEnv(name, `changed-${name}`);
  expect(fingerprint()).toEqual(before);
  const relocated = join(realpathSync(home), 'relocated');
  cpSync(root, relocated, { recursive: true });
  expect(
    nativeXcodeInputSnapshot(relocated, selectNativeXcodeProject(relocated), {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
      optimizations: resolveOptimizations({}, {}).ios,
    }),
  ).toEqual(before);
  vi.stubEnv('CFLAGS', '-DNATIVE_FEATURE=1');
  expect(fingerprint()).not.toEqual(before);
  vi.stubEnv('CFLAGS', '-include external.h');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CFLAGS') });
  vi.stubEnv('CFLAGS', '');
  vi.stubEnv('CPATH', '/unresolved/external/headers');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CPATH') });
});

test('local Swift packages do not get a partial key that omits their transitive dependencies', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nPACKAGE = { isa = XCLocalSwiftPackageReference; relativePath = Packages/Local; };',
    ),
  );
  write(join(root, 'Packages', 'Local', 'Package.swift'), 'import PackageDescription\n');
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('transitive local dependencies') });
});

test('local package product dependencies without a package reference cannot use a partial artifact key', () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8')
      .replace('children = ( SOURCE, );', 'children = ( SOURCE, LOCAL_PACKAGE, );')
      .replace('name = Native; productType', 'name = Native; packageProductDependencies = ( PRODUCT, ); productType')
      .replace(
        'objects = {',
        `objects = {
LOCAL_PACKAGE = { isa = PBXFileReference; lastKnownFileType = wrapper; path = Packages/Local; sourceTree = "<group>"; };
PRODUCT = { isa = XCSwiftPackageProductDependency; productName = Local; };`,
      ),
  );
  write(
    join(root, 'Packages', 'Local', 'Package.swift'),
    'import PackageDescription\nlet package = Package(name: "Local", dependencies: [.package(path: "../../../External")])\n',
  );
  expect(fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('transitive local dependencies') });
});

test('native planning refuses unresolved source closure without dependency preparation or builds', async () => {
  const project = writeNativeXcodeProject(root);
  const pbx = join(project, 'project.pbxproj');
  writeFileSync(
    pbx,
    readFileSync(pbx, 'utf8').replace(
      'objects = {',
      'objects = {\nSCRIPT = { isa = PBXShellScriptBuildPhase; shellScript = "date"; };',
    ),
  );
  const commands: string[][] = [];
  setExecutor(
    makeExecutor({
      runFile(file, args = []) {
        commands.push([file, ...args]);
        return 'Tool identity';
      },
      spawn() {
        throw new Error('Planning must not spawn dependency preparation or compilation');
      },
    }),
  );
  const plan = await nativeXcodeIosProject(root).plan!({}, unresolvedSettings(root));
  expect(plan).toMatchObject({
    refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('undeclared inputs') },
  });
  expect(commands.some((command) => command.includes('-resolvePackageDependencies') || command.includes('build'))).toBe(
    false,
  );
});

test('stim ios, the build API and --plan share one native artifact key for the same project', async () => {
  writeNativeXcodeProject(root);
  vi.stubEnv('STIM_BUILD_CACHE', join(home, 'cache'));
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const host = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const identity = async (arch: 'arm64' | 'x86_64' | null) => {
    const recipe = nativeXcodeIosProject(root).artifact({
      root,
      configuration: 'Debug',
      target: { udid: null, destination: null, sdk: 'iphonesimulator', arch, keyArch: host },
      optimizations: resolveOptimizations({}, {}).ios,
    } as unknown as IosArtifactContext);
    return recipe.identity();
  };
  const run = await identity(null);
  expect(run).toHaveProperty('key');
  expect(await identity(host)).toEqual(run);
  expect(await nativeXcodeIosProject(root).plan!({}, unresolvedSettings(root))).toMatchObject({
    cacheKey: (run as { key: string }).key,
  });
});

test('ios.scheme selects the scheme for native planning and the native doctor', async () => {
  writeNativeXcodeProject(root);
  write(join(root, '.stim.json'), JSON.stringify({ ios: { scheme: 'Missing' } }));
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  expect(await nativeXcodeIosProject(root).plan!({}, unresolvedSettings(root))).toMatchObject({
    refusal: { message: expect.stringContaining('"Missing"') },
  });
  const findings = nativeXcodeDoctor(root).inspect({
    options: {},
    settings: { ios: { scheme: 'Missing' } },
  } as unknown as Parameters<ReturnType<typeof nativeXcodeDoctor>['inspect']>[0]);
  expect(findings).toMatchObject([{ title: 'Native Xcode selection', detail: expect.stringContaining('"Missing"') }]);
});

test('a native project removed after recipe selection refuses instead of escaping as an unexpected error', async () => {
  const project = writeNativeXcodeProject(root);
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  const recipe = nativeXcodeIosProject(root).artifact({
    root,
    configuration: 'Debug',
    target: { udid: null, destination: null, sdk: 'iphonesimulator', arch: null, keyArch: null },
    optimizations: resolveOptimizations({}, {}).ios,
  } as unknown as IosArtifactContext);
  rmSync(project, { recursive: true });
  await expect(recipe.identity()).rejects.toBeInstanceOf(IosRecipeRefusal);
});

test('native planning validates the simulator model flags like stim ios does', async () => {
  writeNativeXcodeProject(root);
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  expect(await nativeXcodeIosProject(root).plan!({ deviceType: ' ' }, unresolvedSettings(root))).toMatchObject({
    refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('--device-type') },
  });
});

test('the registered native iOS provider builds Release without a device and reuses its complete source identity', async () => {
  const project = writeNativeXcodeProject(root);
  mkdirSync(join(project, 'project.xcworkspace'));
  write(join(root, 'settings.gradle.kts'), 'include(":mobile")');
  write(join(root, 'gradlew'), '');
  write(join(root, '.stim.json'), JSON.stringify({ optimizations: { releaseBundleSwap: false } }));
  vi.stubEnv('STIM_BUILD_CACHE', join(home, 'cache'));
  setExecutor(
    makeExecutor({
      runFile(file, args = []) {
        if (args.includes('simctl')) throw new Error('A local artifact build must not inspect simulator runtimes');
        if (file === 'cp') cpSync(args.at(-2)!, args.at(-1)!, { recursive: true });
        return 'Xcode 26.0 build 17A';
      },
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const compiled = join(home, 'derived', 'Native.app');
  const compile = vi.spyOn(xcode, 'buildXcode').mockImplementation(async (options) => {
    expect(options.udid).toBeNull();
    expect(options.destination).toBe('generic/platform=iOS Simulator');
    expect(options.configuration).toBe('Release');
    mkdirSync(join(project, 'project.xcworkspace', 'xcshareddata', 'swiftpm', 'configuration'), { recursive: true });
    write(join(compiled, 'Native'), readFileSync(join(root, 'Native.swift'), 'utf8'));
    write(
      join(compiled, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.Native</string></dict></plist>',
    );
    return {
      ok: true,
      appPath: compiled,
      bundleId: 'org.example.Native',
      scheme: 'Native',
      project: { dir: root, path: join(root, 'Native.xcodeproj'), kind: 'project', flag: '-project', name: 'Native' },
      derivedDataPath: join(home, 'derived'),
      productsDir: join(home, 'derived'),
      durationMs: 1,
      transcriptLines: 1,
      compilationCache: xcode.COMPILATION_CACHE_NOT_RUN,
    };
  });
  const existing = { udid: 'existing-device', devicePlacement: { machine: 'paired-host' } };
  writeWorkspaceState(root, { ios: existing });
  const options = { configuration: 'Release', arch: 'arm64', remoteBuild: 'local' } as const;
  const cold = await buildIosOperation(root, options);
  expect(cold.cacheKey).not.toBeNull();
  const bytes = readFileSync(join(cold.appPath, 'Native'), 'utf8');
  const warm = await buildIosOperation(root, options);
  expect(warm).toMatchObject({ cacheHit: 'local', cacheSkipped: false, cacheKey: cold.cacheKey });
  expect(compile).toHaveBeenCalledTimes(1);
  write(join(root, 'Native.swift'), 'struct EditedApp {}');
  const edited = await buildIosOperation(root, options);
  expect(edited.cacheKey).not.toBe(cold.cacheKey);
  expect(compile).toHaveBeenCalledTimes(2);
  rmSync(join(home, 'derived'), { recursive: true });
  expect(readFileSync(join(cold.appPath, 'Native'), 'utf8')).toBe(bytes);
  expect(readFileSync(join(edited.appPath, 'Native'), 'utf8')).toBe('struct EditedApp {}');
  expect(readWorkspaceState(root)?.ios).toEqual(existing);
  expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
});

test('native run and worker build-only recipes share the selected architecture identity', async () => {
  writeNativeXcodeProject(root);
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  const unused = () => {
    throw new Error('Identity must not prepare or compile');
  };
  const context: IosArtifactContext = {
    root,
    logFile: join(home, 'build.ndjson'),
    configuration: 'Debug',
    target: {
      udid: 'owned-device',
      destination: null,
      sdk: 'iphonesimulator',
      arch: null,
      keyArch: 'arm64',
      offloadRuntime: () => 'iOS-26-0',
      offloadRefusal: null,
    },
    device: null,
    optimizations: resolveOptimizations({}, {}).ios,
    cache: { read: true, write: true, remote: true },
    phase: unused,
    note: unused,
    logWriter: unused,
    estimates: unused,
    step: unused,
    setPodsMs: unused,
  };
  const project = nativeXcodeIosProject(root);
  const run = project.artifact(context);
  const worker = project.artifact({
    ...context,
    target: { ...context.target, udid: null, destination: 'generic/platform=iOS Simulator', arch: 'arm64' },
  });
  const identity = await run.identity();
  expect(identity).not.toHaveProperty('cacheIneligible');
  expect(await worker.identity()).toEqual(identity);
  expect(run.offload!.request('iOS-26-0').native).toMatchObject({ arch: 'arm64' });
  const other = project.artifact({ ...context, target: { ...context.target, keyArch: 'x86_64' } });
  expect(await other.identity()).not.toEqual(identity);
});

test('an ignored native input keeps placement here instead of failing during the source transfer', async () => {
  const real = getExecutor();
  real.runFile('git', ['init', '--quiet', root]);
  writeNativeXcodeProject(root);
  write(join(root, '.gitignore'), '.DS_Store\n');
  write(join(root, '.DS_Store'), 'Finder metadata');
  setExecutor(
    makeExecutor({ runFile: (file, args, options) => (file === 'git' ? real.runFile(file, args, options) : 'Xcode') }),
  );
  const unused = () => {
    throw new Error('Placement must not prepare or compile');
  };
  const recipe = nativeXcodeIosProject(root).artifact({
    root,
    logFile: join(home, 'build.ndjson'),
    configuration: 'Debug',
    target: {
      udid: 'owned-device',
      destination: null,
      sdk: 'iphonesimulator',
      arch: null,
      keyArch: 'arm64',
      offloadRuntime: () => 'iOS-26-0',
      offloadRefusal: null,
    },
    device: null,
    optimizations: resolveOptimizations({}, {}).ios,
    cache: { read: true, write: true, remote: true },
    phase: unused,
    note: unused,
    logWriter: unused,
    estimates: unused,
    step: unused,
    setPodsMs: unused,
  });
  expect(await recipe.identity()).not.toHaveProperty('cacheIneligible');
  expect(recipe.offload!.context().unsupported).toContain('.DS_Store');
  rmSync(join(root, '.DS_Store'));
  expect(await recipe.identity()).not.toHaveProperty('cacheIneligible');
  expect(recipe.offload!.context()).toEqual({ runtime: 'iOS-26-0', unsupported: null });
});
