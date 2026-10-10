import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { buildCacheKey, filesystemBuildCapability } from '../cache/build-cache.ts';
import { explainBuildMiss, skippedMissReason } from '../cache/miss-reason.ts';
import { register } from '../cache/cache-manifest.ts';
import { iosProcessRuntime } from '../commands/ios/launch.ts';
import {
  deviceModelRefusal,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  simulatorBuildArch,
} from '../commands/ios/support.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { planCachedBuild, planFlagRefusal } from '../commands/build-plan.ts';
import {
  buildXcode,
  compilationCacheSettings,
  HEARTBEAT_INTERVAL_MS,
  parseSwiftVersion,
  parseXcodeMajor,
} from '../engine/xcode.ts';
import { readPodState, podsAreStale, runPodInstall, runCaptured } from '../engine/deps.ts';
import { gateProfileForDevice } from '../engine/ios-signing.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { sharedCompilationCache } from '../workspace/paths.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import {
  remoteIosSetting,
  resolveCacheProviderConfig,
  resolveSettings,
  settingShapeErrors,
} from '../workspace/settings.ts';
import { artifactCachePolicy, resolveOptimizations } from '../optimizations.ts';
import {
  nativeXcodeHasPackages,
  nativeXcodeInputSnapshot,
  nativeXcodePackages,
  nativeXcodeSources,
} from './native-xcode-inputs.ts';
import { NativeXcodeError, pbxString, selectNativeXcodeProject } from './native-xcode-project.ts';
import { IosRecipeRefusal, type IosArtifactContext, type IosArtifactRecipe, type IosProject } from './ios-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';
import type { NativeInputSnapshot } from './native-inputs.ts';
import type { IosCommandOptions } from '../commands/ios/types.ts';

function toolchain(sdk: string): Record<string, string> {
  const executor = getExecutor();
  const identity = {
    xcode: executor.runFile('xcodebuild', ['-version'], { timeoutMs: 10_000 }),
    sdk: executor.runFile('xcodebuild', ['-version', '-sdk', sdk], { timeoutMs: 10_000 }),
    swift: executor.runFile('xcrun', ['swift', '--version'], { timeoutMs: 10_000 }),
    clang: executor.runFile('xcrun', ['clang', '--version'], { timeoutMs: 10_000 }),
    developer: executor.runFile('xcode-select', ['-p'], { timeoutMs: 10_000 }),
    developerOverride: process.env.DEVELOPER_DIR ?? '',
    toolchains: process.env.TOOLCHAINS ?? '',
  };
  if (
    !identity.xcode.trim() ||
    !identity.sdk.trim() ||
    !identity.swift.trim() ||
    !identity.clang.trim() ||
    !identity.developer.trim()
  )
    throw new Error('An Xcode toolchain probe returned no identity.');
  return identity;
}

function refusal(error: unknown) {
  return error instanceof NativeXcodeError
    ? { code: error.code, message: error.message, remedy: error.remedy }
    : {
        code: 'STIM_BAD_ARG',
        message: (error as Error).message,
        remedy: 'Check the native Xcode project and its selected toolchain, then retry.',
      };
}

function settingsContext(root: string) {
  return { projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) };
}

function nativeRecipe(root: string, context: IosArtifactContext): IosArtifactRecipe {
  const configuration = context.configuration ?? 'Debug';
  let selected = selectNativeXcodeProject(root, context.buildScheme, configuration);
  let tools: Record<string, string> | null = null;
  let snapshot: NativeInputSnapshot | null = null;
  let ineligible: string | null = null;
  const mutations: string[] = [];
  const identity = (value: NativeInputSnapshot) => ({
    hash: value.hash,
    key: buildCacheKey('ios', value.hash, {
      configuration,
      scheme: selected.scheme,
      isSimulator: context.target.sdk === 'iphonesimulator',
      ...(context.target.keyArch ? { arch: context.target.keyArch } : {}),
    }),
  });
  const reselect = () => {
    try {
      selected = selectNativeXcodeProject(root, context.buildScheme, configuration);
    } catch (error) {
      throw new IosRecipeRefusal(refusal(error));
    }
  };
  const read = () => {
    if (!tools) return { cacheIneligible: ineligible ?? 'Xcode toolchain identity is unavailable' };
    reselect();
    return nativeXcodeInputSnapshot(
      root,
      selected,
      {
        sdk: context.target.sdk,
        architecture: context.target.keyArch,
        toolchain: tools,
        optimizations: context.optimizations,
      },
      repoRoot(root) ?? root,
    );
  };
  return {
    async identity() {
      try {
        tools = toolchain(context.target.sdk);
      } catch (error) {
        ineligible = `Xcode toolchain identity is unavailable: ${(error as Error).message}`;
        return { cacheIneligible: ineligible };
      }
      const value = read();
      if ('cacheIneligible' in value) {
        ineligible = value.cacheIneligible;
        return value;
      }
      snapshot = value;
      return identity(value);
    },
    cache: () => filesystemBuildCapability({ sources: snapshot ? nativeXcodeSources(snapshot) : null }),
    async prepare(beforePrepare) {
      const pods = readPodState(root, root);
      const state = podsAreStale(pods.lockText, pods.manifestText);
      if (pods.hasPodfile && (state.stale || state.noPods)) {
        beforePrepare();
        context.step('pods');
        const result = await runPodInstall(root, context.logWriter(), {
          directory: root,
          estimateMs: context.estimates().podsMs,
        });
        if (result.failed)
          throw new IosRecipeRefusal({
            code: result.code ?? 'STIM_DEPS_FAILED',
            message: result.reason,
            remedy: result.remedy ?? `See ${context.logFile}.`,
            lines: result.lastLines,
          });
        context.setPodsMs(result.durationMs ?? 0);
        mutations.push('pod install');
        reselect();
      }
      if (nativeXcodeHasPackages(selected)) {
        beforePrepare();
        context.phase('packages', 'resolving Swift package dependencies');
        const result = await runCaptured({
          cmd: 'xcodebuild',
          args: [
            selected.container.flag,
            selected.container.path,
            '-scheme',
            selected.scheme,
            '-resolvePackageDependencies',
            '-clonedSourcePackagesDirPath',
            nativeXcodePackages(root),
          ],
          cwd: root,
          env: { ...process.env, NSUnbufferedIO: 'YES', FORCE_COLOR: '0' },
          spawn: (file, args, opts) => getExecutor().spawn(file, args, opts),
          now: Date.now,
          heartbeatMs: HEARTBEAT_INTERVAL_MS,
          onHeartbeat: context.note,
          logWriter: context.logWriter(),
          event: 'swift_packages',
          label: 'packages',
        });
        if (result.error || result.code !== 0)
          throw new IosRecipeRefusal({
            code: 'STIM_DEPS_FAILED',
            message: 'Xcode could not resolve Swift package dependencies.',
            remedy: `Resolve the selected scheme's packages in Xcode and inspect ${context.logFile}.`,
            lines: result.transcript.slice(-10),
          });
        mutations.push('Swift package resolution');
      }
    },
    async reconcile() {
      const current = snapshot && !mutations.length ? snapshot : read();
      if ('cacheIneligible' in current) {
        ineligible = current.cacheIneligible;
        snapshot = null;
      } else snapshot = current;
      return {
        identity: snapshot ? identity(snapshot) : null,
        rekeyedBy: mutations,
        mutationLabel: mutations.join(', '),
      };
    },
    async validate() {
      if (!snapshot) return null;
      try {
        tools = toolchain(context.target.sdk);
        const after = read();
        return !('cacheIneligible' in after) && after.hash === snapshot.hash ? identity(snapshot) : null;
      } catch {
        return null;
      }
    },
    validateExternal() {
      throw new IosRecipeRefusal({
        code: 'STIM_BAD_ARG',
        message: 'This native Xcode integration does not use external EAS builds.',
        remedy: 'Build the native project with stim ios.',
      });
    },
    async materialize(path) {
      if (context.device) {
        const gate = gateProfileForDevice({ appPath: path, udid: context.device.udid, configuration });
        if (!gate.ok) throw new IosRecipeRefusal({ code: gate.code, message: gate.reason, remedy: gate.remedy });
      }
      return path;
    },
    compile: () =>
      buildXcode({
        root,
        project: selected.container,
        scheme: selected.scheme,
        configuration,
        applicationTarget: { name: selected.targetName, projectPath: selected.targetProject.path },
        sdk: context.target.sdk,
        udid: context.target.udid,
        destination: context.target.destination,
        arch: context.target.arch,
        logWriter: context.logWriter(),
        estimateMs: context.estimates().coldBuildMs,
        extraArgs: nativeXcodeHasPackages(selected)
          ? ['-clonedSourcePackagesDirPath', nativeXcodePackages(root), '-disableAutomaticPackageResolution']
          : [],
        compilationCache: ({ derivedDataPath }) => {
          const casPath = sharedCompilationCache();
          const settings = compilationCacheSettings({
            workspaceRoot: root,
            derivedDataPath,
            casPath,
            xcodeMajor: parseXcodeMajor(tools?.xcode),
            swiftVersion: parseSwiftVersion(tools?.swift),
            swiftCacheCompatible:
              (!process.env.SWIFT_ENABLE_EXPLICIT_MODULES || process.env.SWIFT_ENABLE_EXPLICIT_MODULES === 'YES') &&
              !selected.projects.some((project) =>
                [...project.objects.values()].some((entry) => {
                  if (entry.isa !== 'XCBuildConfiguration' || pbxString(entry.name) !== configuration) return false;
                  const targetSettings = entry.buildSettings as Record<string, unknown> | undefined;
                  const explicitModules = pbxString(targetSettings?.SWIFT_ENABLE_EXPLICIT_MODULES);
                  return explicitModules !== null && explicitModules !== 'YES';
                }),
              ),
            optimizations: context.optimizations,
          });
          if (settings.length && context.optimizations.compilationCache)
            register({
              dir: casPath,
              name: 'Xcode compilation cache',
              prune: 'atomic',
              note: 'shared Xcode compilation cache',
            });
          return settings;
        },
      }),
    explain(rekeyedBy) {
      if (!snapshot)
        return { reason: skippedMissReason(ineligible ?? 'Native build inputs are not cacheable'), diff: null };
      const result = explainBuildMiss({
        root,
        platform: 'ios',
        current: { hash: snapshot.hash, sources: nativeXcodeSources(snapshot) },
        rekeyedBy,
      });
      return { reason: result.reason, diff: null };
    },
    untrackedLine: () => null,
    legacyCache: null,
    offload: null,
  };
}

async function planNativeXcode(root: string, options: IosCommandOptions) {
  const flag =
    options.device !== undefined
      ? '--device'
      : options.remote
        ? '--remote'
        : options.easProfile !== undefined
          ? '--eas-profile'
          : options.wait !== undefined
            ? '--wait'
            : null;
  if (flag) return { refusal: planFlagRefusal(flag) };
  try {
    const context = settingsContext(root);
    const settings = resolveSettings(context);
    const errors = settingShapeErrors(settings);
    if (errors.length) throw new NativeXcodeError(errors.join('; '), 'Correct the project settings and retry.');
    if (remoteIosSetting(settings))
      throw new NativeXcodeError(
        'The native Xcode integration does not yet support hosted placement.',
        'Unset ios.remote to build and run on a local owned simulator.',
      );
    const layers = DEFAULT_DEPS.settingsLayers(context);
    const modelRefusal = deviceModelRefusal({
      slot: options.slot ?? 'default',
      deviceTypeFlag: options.deviceType,
      runtimeFlag: options.runtime,
      deviceType: resolveDeviceType(options.deviceType, settings),
      runtime: resolveRuntime(options.runtime, settings),
      deviceTypeOrigin: DEFAULT_DEPS.settingOriginScope(layers, 'ios.deviceType'),
      runtimeOrigin: DEFAULT_DEPS.settingOriginScope(layers, 'ios.runtime'),
      physical: false,
      remoteBackend: null,
      listRuntimes: DEFAULT_DEPS.listIosRuntimes,
    });
    if (modelRefusal) return { refusal: modelRefusal };
    const configuration = resolveConfiguration(options.configuration, settings) ?? 'Debug';
    const selection = selectNativeXcodeProject(root, options.scheme, configuration);
    const optimizations = resolveOptimizations(settings);
    const architecture = simulatorBuildArch({
      physical: false,
      remoteArch: null,
      hostArch: process.arch === 'arm64' ? 'arm64' : 'x86_64',
      configuration,
    });
    const snapshot = nativeXcodeInputSnapshot(
      root,
      selection,
      {
        sdk: 'iphonesimulator',
        architecture,
        toolchain: toolchain('iphonesimulator'),
        optimizations: optimizations.ios,
      },
      context.repoRoot ?? root,
    );
    if ('cacheIneligible' in snapshot)
      throw new NativeXcodeError(
        `No reusable native artifact can be predicted: ${snapshot.cacheIneligible}.`,
        'Run stim ios without --plan; it can prepare dependencies and build locally without artifact caching.',
      );
    const key = buildCacheKey('ios', snapshot.hash, {
      configuration,
      scheme: selection.scheme,
      isSimulator: true,
      ...(architecture ? { arch: architecture } : {}),
    });
    return await planCachedBuild(
      {
        root,
        platform: 'ios',
        slot: options.slot ?? 'default',
        projectKey: statsProjectKey({ root, commonDir: context.gitCommonDir, repoRoot: context.repoRoot }),
        isExpo: false,
        fingerprint: snapshot.hash,
        sources: nativeXcodeSources(snapshot),
        cacheKey: key,
        cachePolicy: artifactCachePolicy(optimizations, options.buildCache !== false, false),
        providerConfig: resolveCacheProviderConfig(context),
        expoRemote: null,
      },
      { ...DEFAULT_DEPS, planPrebuild: () => 'none', note: (line) => console.error(line) },
    );
  } catch (error) {
    return { refusal: refusal(error) };
  }
}

export function nativeXcodeIosProject(root: string): IosProject {
  return {
    isExpo: false,
    targets: ['simulator', 'physical'],
    eas: false,
    runtimeKind: () => 'process',
    plan: (options) => planNativeXcode(root, options),
    bundleId: () => null,
    schemeProblem(scheme, configuration) {
      try {
        selectNativeXcodeProject(root, scheme, configuration ?? 'Debug');
        return null;
      } catch (error) {
        return refusal(error);
      }
    },
    runtime: () => iosProcessRuntime(async () => ({ ok: true, prepared: { metroPort: null } })),
    artifact: (context) => nativeRecipe(root, context),
  };
}

export function nativeXcodeDoctor(root: string): ProjectDoctor {
  return {
    inspect({ options, settings }) {
      if (options.platform && options.platform !== 'ios') return [];
      try {
        const selection = selectNativeXcodeProject(
          root,
          undefined,
          resolveConfiguration(undefined, settings) ?? 'Debug',
        );
        const podfile = existsSync(join(root, 'Podfile'));
        return [
          {
            level: 'note',
            title: 'Native Xcode application',
            detail: `${selection.scheme} (${selection.configuration}) uses native process readiness without Metro.${podfile ? ' CocoaPods dependencies are prepared from the project root.' : ''}`,
            fix: null,
          },
        ];
      } catch (error) {
        const problem = refusal(error);
        return [{ level: 'cost', title: 'Native Xcode selection', detail: problem.message, fix: problem.remedy }];
      }
    },
  };
}
