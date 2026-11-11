import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject, machineCapacity, placementWord, readJsonObject } from '@stim-cli/core/state';
import { OffloadRefusal } from '../build-placement.ts';
import { filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { processContext } from '../cli-operation.ts';
import { planFlagRefusal, planPayload } from '../commands/build-plan.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { hostedIosSelectors } from '../commands/ios/remote.ts';
import { iosProcessRuntime } from '../commands/ios/launch.ts';
import {
  deviceModelRefusal,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
} from '../commands/ios/support.ts';
import type { FailArgs, IosCommandOptions } from '../commands/ios/types.ts';
import { runCaptured } from '../engine/deps.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { COMPILATION_CACHE_UNAVAILABLE, HEARTBEAT_INTERVAL_MS, readBundleId } from '../engine/xcode.ts';
import { iosToolchainAsync, type BuildTarget } from '../engine/toolchain.ts';
import { planHostedDevice } from '../device-host/plan-placement.ts';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { sourceManifest } from '../offload/native-source.ts';
import { iosSyncPlan } from '../offload/signing-files.ts';
import {
  parseIosRemote,
  remoteIosSetting,
  type ResolvedProjectSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
} from '../workspace/settings.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import {
  exactDeclaresModules,
  exactLocalToolProblems,
  exactOffloadPlan,
  type ExactOffload,
  type ExactPins,
} from './exact-offload.ts';
import {
  IosRecipeRefusal,
  type IosArtifactContext,
  type IosArtifactRecipe,
  type IosCompileResult,
  type IosProject,
} from './ios-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';
import type { PlanRefusal, ProjectPlanResult } from './project-plan.ts';

const EXACT_CLI = 'exact.mjs';
const CACHE_INELIGIBLE = 'Exact builds incrementally in its own target/ directory';
const BUILT_APP = /^host\/apple: (\/.+?\.app)(?: on | \(|$)/;
const ERROR_LINE = /^error(?:\[\w+\])?: /;
// exact2's host/apple builds the simulator's Rust code under target/<triple>/<profile>: host-dev, or release with --release.
// CARGO_TARGET_DIR moves it, so such a run does not say; an enclosing Cargo workspace or a size-optimized Release reads as a first build.
const SIMULATOR_RUST_TARGET = process.arch === 'arm64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';

function exactIncremental(root: string, configuration: string | null, env: NodeJS.ProcessEnv): boolean | undefined {
  if (env.CARGO_TARGET_DIR) return undefined;
  const profile = configuration === 'Release' ? 'release' : 'host-dev';
  return existsSync(join(root, 'target', SIMULATOR_RUST_TARGET, profile));
}

function exactBuiltApp(lines: readonly string[]): string | null {
  for (const line of lines.toReversed()) {
    const app = BUILT_APP.exec(line)?.[1];
    if (app) return app;
  }
  return null;
}

/** Runs `./exact.mjs ios --no-install` in `root` and reads the app it built; the caller decides `EXACT_SIM`. */
export async function runExactIosBuild({
  root,
  release,
  env,
  logWriter,
  onHeartbeat,
  estimateMs,
}: {
  root: string;
  release: boolean;
  env: NodeJS.ProcessEnv;
  logWriter: NdjsonWriter;
  onHeartbeat: (line: string) => void;
  estimateMs: number | null;
}): Promise<IosCompileResult> {
  const run = await runCaptured({
    cmd: join(root, EXACT_CLI),
    args: ['ios', '--no-install', ...(release ? ['--release'] : [])],
    cwd: root,
    env: { ...env, FORCE_COLOR: '0' },
    spawn: (file, args, opts) => getExecutor().spawn(file, args, opts),
    now: Date.now,
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
    onHeartbeat,
    logWriter,
    event: 'exact_build',
    label: 'build',
    estimateMs,
  });
  const common = {
    durationMs: run.durationMs,
    transcriptLines: run.transcript.length,
    compilationCache: COMPILATION_CACHE_UNAVAILABLE,
  };
  const appPath = run.error || run.code !== 0 ? null : exactBuiltApp(run.transcript);
  if (appPath && existsSync(appPath)) {
    const bundleId = await readBundleId(appPath);
    if (bundleId) return { ...common, ok: true, appPath, bundleId };
  }
  const errorLines = run.transcript.filter((line) => ERROR_LINE.test(line));
  const lastLine = run.transcript.at(-1);
  const errors = [
    ...(run.error ? [`could not run ./${EXACT_CLI}: ${String(run.error)}`] : []),
    ...(!run.error && run.code === 0 ? [`./${EXACT_CLI} ios reported no built app with a bundle id`] : []),
    ...(errorLines.length === 0 && !run.error && run.code !== 0 && lastLine ? [lastLine] : errorLines),
  ];
  return {
    ...common,
    ok: false,
    code: 'STIM_BUILD_FAILED',
    diagnostics: errors.slice(0, 10).map((message) => ({ message })),
    truncated: Math.max(0, errors.length - 10),
    exitCode: run.code,
    tail: run.transcript.slice(-20),
  };
}

async function compile(
  root: string,
  context: IosArtifactContext,
  booting: ReturnType<NonNullable<IosArtifactContext['target']['booted']>> | null,
): Promise<IosCompileResult> {
  const run = (env: NodeJS.ProcessEnv) =>
    runExactIosBuild({
      root,
      release: context.configuration === 'Release',
      env,
      logWriter: context.logWriter(),
      onHeartbeat: context.note,
      estimateMs: context.estimates().coldBuildMs,
    });
  if (!booting) {
    const manifest = readJsonObject(join(root, 'app.json'));
    if (manifest && exactDeclaresModules(manifest))
      throw new IosRecipeRefusal({
        code: 'STIM_BAD_ARG',
        message:
          "This Exact app declares native modules in app.json, and Exact may run code on a simulator to read them, so it builds only on this workspace's own booted simulator.",
        remedy:
          'Build and run it with stim ios; build-only runs (stim ci build) support Exact apps without native modules.',
      });
    return run({ ...context.operation?.env });
  }
  const booted = await booting;
  if (!booted.ok)
    throw new IosRecipeRefusal({
      code: 'STIM_NO_DEVICE',
      message: booted.reason,
      remedy: 'Run stim ios again to re-establish an owned simulator for this workspace.',
    });
  return run({ ...context.operation?.env, EXACT_SIM: booted.udid });
}

async function exactOffloadTarget(root: string, { exact2, bun, rust }: ExactPins): Promise<BuildTarget> {
  return {
    platform: 'ios',
    local: await iosToolchainAsync(root, null),
    runtime: null,
    cocoapodsPinned: false,
    exact: { exact2, bun, rust },
  };
}

function exactRecipe(root: string, context: IosArtifactContext): IosArtifactRecipe {
  let booting: ReturnType<NonNullable<IosArtifactContext['target']['booted']>> | null = null;
  const boot = () => (booting ??= context.target.booted?.() ?? null);
  let plan: ExactOffload | { unsupported: string } | null = null;
  const offloadPlan = () => (plan ??= exactOffloadPlan(root, context.operation?.env ?? {}));
  const offloaded = (): ExactOffload => {
    const planned = offloadPlan();
    if ('unsupported' in planned) throw new Error(`An Exact offload has no plan: ${planned.unsupported}`);
    return planned;
  };
  return {
    buildTool: EXACT_CLI,
    identity: async () => {
      await boot();
      const incremental = exactIncremental(root, context.configuration, context.operation?.env ?? {});
      return { cacheIneligible: CACHE_INELIGIBLE, ...(incremental === undefined ? {} : { incremental }) };
    },
    cache: () =>
      filesystemBuildCapability({
        context: context.operation,
        sources: null,
        readAppId: (path) => readBundleId(path),
      }),
    prepare: async () => {},
    reconcile: async () => ({ identity: null, rekeyedBy: [], mutationLabel: '' }),
    validate: async () => null,
    validateExternal() {
      throw new IosRecipeRefusal({
        code: 'STIM_BAD_ARG',
        message: 'The Exact integration does not use external builds.',
        remedy: 'Build the app with stim ios.',
      });
    },
    materialize: async (path) => path,
    compile: () => compile(root, context, boot()),
    explain: () => ({ reason: skippedMissReason(CACHE_INELIGIBLE), diff: null }),
    untrackedLine: () => null,
    expoCache: null,
    offload: {
      uncached: true,
      context: () => {
        const runtime = context.target.offloadRuntime();
        const planned = context.target.offloadRefusal || !runtime ? null : offloadPlan();
        return {
          runtime,
          unsupported:
            context.target.offloadRefusal ??
            (!runtime
              ? 'no simulator runtime is available for worker selection'
              : planned && 'unsupported' in planned
                ? planned.unsupported
                : null),
        };
      },
      target: () => exactOffloadTarget(root, offloaded()),
      request: (runtime) => ({
        platform: 'ios',
        runtime,
        configuration: context.configuration,
        scheme: null,
        isExpo: false,
        optimizations: null,
        exact: offloaded(),
      }),
      syncPlan: iosSyncPlan,
      unchanged: async (sourceDigest) => {
        const signal = context.operation?.signal;
        const found = await repoRootAsync(root, { env: context.operation?.env, signal });
        if (found === null) return false;
        const repoRoot = realpathSync(found);
        const files = await sourceManifest(repoRoot, false, signal);
        const synced = await iosSyncPlan(
          repoRoot,
          files.map((file) => file.path),
        );
        return sourceDigest === manifestDigest(files.filter((file) => !synced.omit.has(file.path)));
      },
    },
  };
}

function exactBundleId(root: string): string | null {
  const app = readJsonObject(join(root, 'app.json'))?.app;
  const id = isJsonObject(app) ? app.id : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

function exactSchemeProblem(scheme: string | undefined, configuration: string | null | undefined): FailArgs | null {
  if (scheme !== undefined || (configuration && configuration !== 'Debug' && configuration !== 'Release'))
    return {
      code: 'STIM_BAD_ARG',
      message:
        'Exact apps have no Xcode schemes; --configuration takes Debug (the development app) or Release (./exact.mjs ios --release).',
      remedy: 'Drop --scheme, and pass --configuration Debug or Release.',
    };
  return null;
}

async function exactBuildPlacement(
  root: string,
  preference: string,
  env: NodeJS.ProcessEnv,
): Promise<{ refusal: PlanRefusal } | { buildPlacement: { preference: string; reason: string } } | null> {
  if (placementWord(preference) === 'local') return null;
  const planned = exactOffloadPlan(root, env);
  if (!('unsupported' in planned)) return null;
  const { buildPlacementCandidates, offloadPlacement } = await import('../offload/client.ts');
  const { machines, localEnabled } = buildPlacementCandidates(preference);
  try {
    const placement = offloadPlacement({
      machines: machines.length,
      here: machineCapacity(),
      unsupported: planned.unsupported,
      localEnabled,
      selected: preference,
    });
    return { buildPlacement: { preference, reason: `builds on this machine: ${placement.reason}` } };
  } catch (error) {
    if (!(error instanceof OffloadRefusal)) throw error;
    return { refusal: { code: error.code, message: error.message, remedy: error.remedy } };
  }
}

async function planExactIos(
  root: string,
  options: IosCommandOptions,
  { context, settings }: ResolvedProjectSettings,
  operation: StimContext,
): Promise<ProjectPlanResult> {
  if (options.easProfile !== undefined) return { refusal: planFlagRefusal('--eas-profile') };
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError)
    return {
      refusal: { code: 'STIM_BAD_ARG', message: shapeError, remedy: SETTING_SHAPE_REMEDY },
      lines: moreShapeErrors,
    };
  const remote = options.remote !== undefined ? parseIosRemote(options.remote) : remoteIosSetting(settings);
  if (remote?.kind === 'backend')
    return {
      refusal: {
        code: 'STIM_BAD_ARG',
        message: 'This project integration does not support the remote iOS target.',
        remedy: 'Use a local iOS simulator for this integration.',
      },
    };
  const hostedUnsupported = exactHostedUnsupported(root);
  if (remote && hostedUnsupported && (remote.machine !== 'auto' || remote.placement === 'remote-only'))
    return {
      refusal: {
        code: 'STIM_BAD_ARG',
        message: `This app cannot run on a hosted iOS simulator: ${hostedUnsupported}.`,
        remedy: 'Run it on a simulator on this Mac with --remote local, or unset ios.remote.',
      },
    };
  const layers = DEFAULT_DEPS.settingsLayers(context);
  const slot = options.slot ?? 'default';
  const modelRefusal = await deviceModelRefusal({
    slot,
    deviceTypeFlag: options.deviceType,
    runtimeFlag: options.runtime,
    deviceType: resolveDeviceType(options.deviceType, settings),
    runtime: resolveRuntime(options.runtime, settings),
    deviceTypeOrigin: DEFAULT_DEPS.settingOriginScope(layers, 'ios.deviceType'),
    runtimeOrigin: DEFAULT_DEPS.settingOriginScope(layers, 'ios.runtime'),
    physical: false,
    remoteBackend: null,
    listRuntimes: DEFAULT_DEPS.listIosRuntimes,
    signal: operation.signal,
  });
  if (modelRefusal) return { refusal: modelRefusal };
  const configuration = resolveConfiguration(options.configuration, settings);
  const schemeProblem = exactSchemeProblem(options.scheme, configuration);
  if (schemeProblem)
    return {
      refusal: { code: schemeProblem.code, message: schemeProblem.message ?? '', remedy: schemeProblem.remedy ?? '' },
    };
  let devicePlacement = remote && hostedUnsupported ? `this machine; ${hostedUnsupported}` : 'this machine';
  if (remote && !hostedUnsupported) {
    const planned = await planHostedDevice({
      operation,
      root,
      slot,
      platform: 'ios',
      machine: remote.machine,
      buildMachine: options.remoteBuild,
      ...(remote.placement ? { placement: remote.placement } : {}),
      selectors: hostedIosSelectors(
        resolveDeviceType(options.deviceType, settings),
        resolveRuntime(options.runtime, settings),
      ),
      sameKey: () => true,
    });
    if (planned.kind === 'refused')
      return { refusal: { code: planned.code, message: planned.message, remedy: planned.remedy } };
    devicePlacement = planned.kind === 'unknown' ? `unknown; ${planned.reason}` : planned.placement;
  }
  const placement = await exactBuildPlacement(root, options.remoteBuild ?? 'auto', operation.env);
  const plan = planPayload(
    {
      platform: 'ios',
      slot,
      root,
      projectKey: statsProjectKey({ root, commonDir: context.gitCommonDir, repoRoot: context.repoRoot }),
    },
    {
      fingerprint: null,
      cacheKey: null,
      cacheHit: false,
      provider: null,
      cacheSkipped: false,
      prebuild: null,
      missReason: skippedMissReason(CACHE_INELIGIBLE),
      refusal: placement && 'refusal' in placement ? placement.refusal : null,
    },
    exactIncremental(root, configuration, operation.env),
  );
  const bundleId = exactBundleId(root);
  return {
    ...plan,
    placement: devicePlacement,
    ...(placement && 'buildPlacement' in placement ? { buildPlacement: placement.buildPlacement } : {}),
    ...(bundleId ? { bundleId } : {}),
  };
}

function exactHostedUnsupported(root: string): string | undefined {
  const manifest = readJsonObject(join(root, 'app.json'));
  return !manifest || !exactDeclaresModules(manifest)
    ? undefined
    : 'an Exact app that declares native modules builds next to its own simulator, since Exact may run code on it to read them';
}

export function exactIosProject(root: string): IosProject {
  const hostedUnsupported = exactHostedUnsupported(root);
  return {
    plan: (options, resolved, operation) => planExactIos(root, options, resolved, operation ?? processContext(root)),
    isExpo: false,
    targets: hostedUnsupported ? ['simulator'] : ['simulator', 'hosted'],
    ...(hostedUnsupported ? { hostedUnsupported } : {}),
    eas: false,
    runtimeKind: () => 'process',
    bundleId: () => exactBundleId(root),
    schemeProblem: exactSchemeProblem,
    runtime: () => iosProcessRuntime(async () => ({ ok: true, prepared: { metroPort: null } })),
    artifact: (context) => exactRecipe(root, context),
  };
}

export function exactDoctor(): ProjectDoctor {
  return {
    inspect: ({ root, options }) =>
      options.platform && options.platform !== 'ios'
        ? []
        : [
            {
              level: 'note',
              title: 'Exact application',
              detail: `stim ios builds with ./${EXACT_CLI} ios --no-install (--release for --configuration Release) on the workspace's own simulator and launches it without Metro. Run Exact's own commands (test, agent) with EXACT_SIM set to that simulator.`,
              fix: null,
            },
            ...((options.host ?? process.platform) === 'darwin'
              ? exactLocalToolProblems(root, options.operation?.env ?? options.remoteEnv ?? {})
              : []
            ).map(({ reason, commands }) => ({
              code: 'exact-tools',
              level: 'cost' as const,
              title: "This Mac lacks part of Exact's toolchain",
              detail: `${reason}. ./${EXACT_CLI} ios needs it to build this app.`,
              fix: commands.join(' && '),
            })),
          ],
    offloadTargets: ({ root, options: { platform, operation, remoteEnv } }) => {
      if (platform && platform !== 'ios') return null;
      const plan = exactOffloadPlan(root, operation?.env ?? remoteEnv ?? {});
      return 'unsupported' in plan ? null : async () => [await exactOffloadTarget(root, plan)];
    },
  };
}
