import { resolveSettings } from '../workspace/settings.ts';
import assert from 'node:assert';
import { createStim } from '../api.ts';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { testContext } from './_context.ts';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as xcode from '../engine/xcode.ts';
import * as offload from '../offload/client.ts';
import * as sharedState from '@stim-cli/core/state';
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
import { nativeXcodeIdentityContext, writeNativeXcodeProject } from './_native-xcode-project.ts';
import * as worktree from '../workspace/worktree.ts';

function resolvedSettings(root: string) {
  const context = { projectPath: root, gitCommonDir: null, repoRoot: null };
  return { context, settings: resolveSettings(context) };
}

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-xcode-')));
  home = mkdtempSync(join(tmpdir(), 'stim-native-xcode-home-'));
  process.env.STIM_HOME = home;
  vi.spyOn(worktree, 'repoRootAsync').mockResolvedValue(root);
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
  return nativeXcodeInputSnapshot(
    root,
    selectNativeXcodeProject(root),
    {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
      optimizations: resolveOptimizations({}, {}).ios,
    },
    process.env,
  );
}

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
])('base xcconfig platform declaration %s admits the native app without executing tools', async (platform) => {
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
  expect(
    projectRegistry.detectPlatforms(root, {
      context: { projectPath: root, gitCommonDir: null, repoRoot: null },
      settings: {},
    }),
  ).toEqual(['ios']);
  for (const configuration of ['Debug', 'Release', 'Staging']) {
    expect(selectNativeXcodeProject(root, undefined, configuration).platform).toBe('ios');
  }
  expect(await fingerprint()).toHaveProperty('hash');
});

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
    expect(await fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('application platform') });
    setExecutor(
      makeExecutor({
        runFile: () => 'Tool identity',
        spawn: () => {
          throw new Error('Planning cannot spawn');
        },
      }),
    );
    expect(await nativeXcodeIosProject(root).plan!({}, resolvedSettings(root))).toMatchObject({
      refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('application platform') },
    });
  },
);

test('quoted conditional platform keys retain uncertainty instead of claiming an iOS cache identity', async () => {
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
  expect(await fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('application platform') });
});

test('Metal includes outside the repository cannot reuse a stale native artifact', async () => {
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
  expect(await fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('compiler include dependency graph'),
  });
  write(join(external, 'Tone.h'), '#define TONE 2\n');
  expect(await fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('compiler include dependency graph'),
  });
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
  expect(
    projectRegistry.detectPlatforms(root, {
      context: { projectPath: root, gitCommonDir: null, repoRoot: null },
      settings: {},
    }),
  ).toEqual([]);
});

test.each(['m', 'metal'])(
  'synchronized source groups inventory their files and refuse unresolved %s includes',
  async (extension) => {
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
    const before = await fingerprint();
    expect(before).not.toHaveProperty('cacheIneligible');
    write(join(root, 'Sources', 'App.swift'), 'struct UpdatedApp {}');
    expect(await fingerprint()).not.toEqual(before);
    write(join(root, 'Sources', `Native.${extension}`), '#include "/external/input.h"\n');
    expect(await fingerprint()).toMatchObject({
      cacheIneligible: expect.stringContaining('compiler include dependency graph'),
    });
  },
);

test('relocation, shell location and task metadata preserve warm identities while compiler environment changes do not', async () => {
  writeNativeXcodeProject(root);
  const before = await fingerprint();
  expect(before).not.toHaveProperty('cacheIneligible');
  for (const name of ['PWD', 'OLDPWD', 'TMPDIR', 'SHLVL', '_', 'STIM_QA_TASK_ID', 'LANG', 'LC_ALL'])
    vi.stubEnv(name, `changed-${name}`);
  expect(await fingerprint()).toEqual(before);
  const relocated = join(realpathSync(home), 'relocated');
  cpSync(root, relocated, { recursive: true });
  expect(
    await nativeXcodeInputSnapshot(
      relocated,
      selectNativeXcodeProject(relocated),
      {
        sdk: 'iphonesimulator',
        architecture: 'arm64',
        toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
        optimizations: resolveOptimizations({}, {}).ios,
      },
      process.env,
    ),
  ).toEqual(before);
  vi.stubEnv('CFLAGS', '-DNATIVE_FEATURE=1');
  expect(await fingerprint()).not.toEqual(before);
  vi.stubEnv('CFLAGS', '-include external.h');
  expect(await fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CFLAGS') });
  vi.stubEnv('CFLAGS', '');
  vi.stubEnv('CPATH', '/unresolved/external/headers');
  expect(await fingerprint()).toMatchObject({ cacheIneligible: expect.stringContaining('CPATH') });
});

test('local Swift packages do not get a partial key that omits their transitive dependencies', async () => {
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
  expect(await fingerprint()).toMatchObject({
    cacheIneligible: expect.stringContaining('transitive local dependencies'),
  });
});

test('stim ios, build and plan APIs and --plan share one native artifact key for the same project', async () => {
  writeNativeXcodeProject(root);
  vi.stubEnv('STIM_BUILD_CACHE', join(home, 'cache'));
  setExecutor(
    makeExecutor({
      runFile: (file) => {
        if (file === 'git') throw new Error('Fixture is not a Git checkout.');
        return 'Xcode 26.0 build 17A';
      },
    }),
  );
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
  assert('key' in run);
  expect(await identity(host)).toEqual(run);
  expect(await nativeXcodeIosProject(root).plan!({}, resolvedSettings(root))).toMatchObject({
    cacheKey: run.key,
  });
  expect(await createStim({ projectRoot: root, home }).plan({ platform: 'ios', slot: 'preview' })).toMatchObject({
    platform: 'ios',
    slot: 'preview',
    cacheKey: run.key,
  });
});

test('ios.scheme selects the scheme for native planning and the native doctor', async () => {
  writeNativeXcodeProject(root);
  write(join(root, '.stim.json'), JSON.stringify({ ios: { scheme: 'Missing' } }));
  setExecutor(makeExecutor({ runFile: () => 'Xcode 26.0 build 17A' }));
  expect(await nativeXcodeIosProject(root).plan!({}, resolvedSettings(root))).toMatchObject({
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
  const cold = await buildIosOperation(testContext(), root, options);
  expect(cold.cacheKey).not.toBeNull();
  const bytes = readFileSync(join(cold.appPath, 'Native'), 'utf8');
  const warm = await buildIosOperation(testContext(), root, options);
  expect(warm).toMatchObject({ cacheHit: 'local', cacheSkipped: false, cacheKey: cold.cacheKey });
  expect(compile).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(warm.appPath, 'Native'), 'utf8')).toBe(bytes);
  write(join(root, 'Native.swift'), 'struct EditedApp {}');
  const edited = await buildIosOperation(testContext(), root, options);
  expect(edited.cacheKey).not.toBe(cold.cacheKey);
  expect(compile).toHaveBeenCalledTimes(2);
  rmSync(join(home, 'derived'), { recursive: true });
  expect(existsSync(cold.appPath)).toBe(false);
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
  real.runFile('git', ['init', '--quiet', root], { timeoutMs: 60_000 });
  writeNativeXcodeProject(root);
  write(join(root, '.gitignore'), 'Native.swift\n');
  setExecutor(
    makeExecutor({
      runFile: (file, args, options) => (file === 'git' ? real.runFile(file, args, options) : 'Xcode'),
      runFileAsync: (file, args, options) =>
        file === 'git' ? real.runFileAsync(file, args, options) : Promise.resolve('Xcode'),
    }),
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
  expect((await recipe.offload!.context()).unsupported).toContain('Native.swift');
  rmSync(join(root, '.gitignore'));
  expect(await recipe.identity()).not.toHaveProperty('cacheIneligible');
  expect(await recipe.offload!.context()).toEqual({ runtime: 'iOS-26-0', unsupported: null });
});

test.each(['identity', 'validate', 'plan', 'api-plan'] as const)(
  'cancelling native %s stops its pending tool and preserves the cancellation reason',
  async (method) => {
    writeNativeXcodeProject(root);
    const controller = new AbortController();
    const reason = new Error('cancel native toolchain probe');
    const executor = getExecutor();
    const recipe = nativeXcodeIosProject(root).artifact(
      nativeXcodeIdentityContext(root, testContext({ signal: controller.signal, cwd: root })),
    );
    if (method === 'validate') {
      setExecutor(makeExecutor({ runFileAsync: async () => 'Tool identity' }));
      await recipe.identity();
    }
    let child: ChildProcess | undefined;
    let probes = 0;
    setExecutor(
      makeExecutor({
        runFileAsync: (file, _args, options) => {
          if (file === 'git') return Promise.reject(new Error('Fixture is not a Git checkout.'));
          probes++;
          return executor.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
            ...options,
            onSpawn(spawned) {
              child = spawned;
              options.onSpawn?.(spawned);
              setTimeout(() => controller.abort(reason), 10);
            },
          });
        },
      }),
    );
    const operation =
      method === 'api-plan'
        ? createStim({ projectRoot: root, home }).plan({ platform: 'ios', signal: controller.signal })
        : method === 'plan'
          ? nativeXcodeIosProject(root).plan!(
              {},
              resolvedSettings(root),
              testContext({ signal: controller.signal, cwd: root }),
            )
          : recipe[method]();
    const failure = await operation.then(
      () => null,
      (error: unknown) => error,
    );
    const actual = method === 'api-plan' && failure instanceof Error && 'code' in failure ? failure.code : failure;
    expect(actual).toBe(method === 'api-plan' ? 'STIM_CANCELLED' : reason);
    expect(child?.signalCode).toBe('SIGKILL');
    expect(probes).toBe(1);
  },
);

test('an idle native iOS build checks peers before taking a compile slot, then stores and reports the reused artifact', async () => {
  writeNativeXcodeProject(root);
  execFileSync('git', ['init', '-q', root]);
  vi.stubEnv('STIM_BUILD_CACHE', join(home, 'cache'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: {}, concurrency: { maxBuilds: 1 } }));
  setExecutor(
    makeExecutor({
      runFile(file, args = [], options) {
        if (file === 'git') return execFileSync(file, args, { encoding: 'utf8', cwd: options.cwd ?? root });
        if (file === 'cp') {
          cpSync(args.at(-2)!, args.at(-1)!, { recursive: true });
          return '';
        }
        if (args.includes('simctl'))
          return JSON.stringify({
            runtimes: [
              { identifier: 'iOS-27-0', version: '27.0', name: 'iOS 27.0', platform: 'iOS', isAvailable: true },
            ],
          });
        return 'Xcode 26.0 build 17A';
      },
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(sharedState, 'machineCapacity').mockReturnValue({
    cpus: 10,
    loadPerCore: 0.1,
    builds: 0,
    maxBuilds: 1,
    maxLoadPerCore: 2,
  });
  vi.spyOn(offload, 'buildPlacementCandidates').mockReturnValue({
    localEnabled: true,
    machines: [
      {
        machine: 'mini',
        transport: 'tailscale',
        address: 'mini.tail.ts.net',
        deviceId: 'builder',
        serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
        state: 'approved',
        requestedAt: '2026-10-12T00:00:00.000Z',
      },
    ],
  });
  const compile = vi.spyOn(xcode, 'buildXcode').mockRejectedValue(new Error('Must reuse without compiling'));
  const choose = vi.spyOn(offload, 'chooseBuildMachine').mockImplementation(async (options) => {
    expect(options.cacheOnly).toBe(true);
    expect(options.artifact?.fingerprint).toBeTruthy();
    expect(options.artifact?.cacheKey).toBeTruthy();
    return { machine: 'mini', offer: { capacity: {} }, cacheOnly: true } as offload.OffloadChoice;
  });
  vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
  vi.spyOn(offload, 'offloadBuild').mockImplementation(async ({ expectedFingerprint, request, stagingDir }) => {
    expect(existsSync(join(home, 'build-slots'))).toBe(false);
    expect(request.platform).toBe('ios');
    if (request.platform !== 'ios') throw new Error('wrong platform');
    expect(request.native?.snapshot.hash).toBe(expectedFingerprint);
    const artifactPath = join(stagingDir, 'Native.app');
    write(join(artifactPath, 'Native'), 'peer executable');
    write(
      join(artifactPath, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.Native</string></dict></plist>',
    );
    return {
      ok: true,
      machine: 'mini',
      cacheHit: true,
      artifactPath,
      compilationCache: xcode.COMPILATION_CACHE_NOT_RUN,
      ccache: { status: 'not-run', hits: null, misses: null, hitRatePercent: null },
      timings: {
        offerMs: 1,
        syncMs: 0,
        workerMs: 0,
        fetchMs: 1,
        totalMs: 2,
        worker: {},
        uploadedBytes: 0,
        artifactBytes: 15,
      },
    };
  });
  const cold = await buildIosOperation(testContext(), root, { remoteBuild: 'auto' });
  expect(cold).toMatchObject({ cacheHit: 'remote', builtOn: 'mini', cacheSkipped: false });
  expect(readFileSync(join(cold.appPath, 'Native'), 'utf8')).toBe('peer executable');
  const warm = await buildIosOperation(testContext(), root, { remoteBuild: 'auto' });
  expect(warm).toMatchObject({ cacheHit: 'local', cacheKey: cold.cacheKey });
  expect(compile).not.toHaveBeenCalled();
  expect(choose).toHaveBeenCalledTimes(1);
});
