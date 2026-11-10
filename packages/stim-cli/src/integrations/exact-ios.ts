import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { iosProcessRuntime } from '../commands/ios/launch.ts';
import { runCaptured } from '../engine/deps.ts';
import { COMPILATION_CACHE_UNAVAILABLE, HEARTBEAT_INTERVAL_MS, readBundleId } from '../engine/xcode.ts';
import { iosToolchainAsync } from '../engine/toolchain.ts';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { sourceManifest } from '../offload/native-source.ts';
import { iosSyncPlan } from '../offload/signing-files.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import { exactOffloadPlan, type ExactOffload } from './exact-offload.ts';
import {
  IosRecipeRefusal,
  type IosArtifactContext,
  type IosArtifactRecipe,
  type IosCompileResult,
  type IosProject,
} from './ios-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';

const EXACT_CLI = 'exact.mjs';
const CACHE_INELIGIBLE = 'Exact builds incrementally in its own target/ directory';
const BUILT_APP = /^host\/apple: (\/.+?\.app)(?: on | \(|$)/;
const ERROR_LINE = /^error(?:\[\w+\])?: /;

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
  if (!booting)
    throw new IosRecipeRefusal({
      code: 'STIM_BAD_ARG',
      message:
        "An Exact build needs this workspace's own booted simulator, because Exact may run the app on it to read its native modules.",
      remedy: 'Build and run Exact apps with stim ios; build-only runs (stim ci build) are not supported.',
    });
  const booted = await booting;
  if (!booted.ok)
    throw new IosRecipeRefusal({
      code: 'STIM_NO_DEVICE',
      message: booted.reason,
      remedy: 'Run stim ios again to re-establish an owned simulator for this workspace.',
    });
  return runExactIosBuild({
    root,
    release: context.configuration === 'Release',
    env: { ...context.operation?.env, EXACT_SIM: booted.udid },
    logWriter: context.logWriter(),
    onHeartbeat: context.note,
    estimateMs: context.estimates().coldBuildMs,
  });
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
      return { cacheIneligible: CACHE_INELIGIBLE };
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
      target: async () => {
        const { exact2, bun, rust } = offloaded();
        return {
          platform: 'ios',
          local: await iosToolchainAsync(root, null),
          runtime: null,
          cocoapodsPinned: false,
          exact: { exact2, bun, rust },
        };
      },
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

export function exactIosProject(root: string): IosProject {
  return {
    isExpo: false,
    targets: ['simulator'],
    eas: false,
    runtimeKind: () => 'process',
    bundleId: () => null,
    schemeProblem(scheme, configuration) {
      if (scheme !== undefined || (configuration && configuration !== 'Debug' && configuration !== 'Release'))
        return {
          code: 'STIM_BAD_ARG',
          message:
            'Exact apps have no Xcode schemes; --configuration takes Debug (the development app) or Release (./exact.mjs ios --release).',
          remedy: 'Drop --scheme, and pass --configuration Debug or Release.',
        };
      return null;
    },
    runtime: () => iosProcessRuntime(async () => ({ ok: true, prepared: { metroPort: null } })),
    artifact: (context) => exactRecipe(root, context),
  };
}

export function exactDoctor(): ProjectDoctor {
  return {
    inspect: ({ options }) =>
      options.platform && options.platform !== 'ios'
        ? []
        : [
            {
              level: 'note',
              title: 'Exact application',
              detail: `stim ios builds with ./${EXACT_CLI} ios --no-install (--release for --configuration Release) on the workspace's own simulator and launches it without Metro. Run Exact's own commands (test, agent) with EXACT_SIM set to that simulator.`,
              fix: null,
            },
          ],
  };
}
