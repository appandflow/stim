import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { iosProcessRuntime } from '../commands/ios/launch.ts';
import { runCaptured } from '../engine/deps.ts';
import { COMPILATION_CACHE_UNAVAILABLE, HEARTBEAT_INTERVAL_MS, readBundleId } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
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

export function exactBuiltApp(lines: readonly string[]): string | null {
  for (const line of lines.toReversed()) {
    const app = BUILT_APP.exec(line)?.[1];
    if (app) return app;
  }
  return null;
}

async function compile(root: string, context: IosArtifactContext): Promise<IosCompileResult> {
  const udid = context.target.udid;
  if (!udid)
    throw new IosRecipeRefusal({
      code: 'STIM_BAD_ARG',
      message:
        "An Exact build needs this workspace's own simulator before it starts, because Exact may run the app on a simulator to read its native modules.",
      remedy:
        'Run stim ios when a simulator slot is free. Build-only and architecture-selected builds of Exact apps are not supported.',
    });
  const run = await runCaptured({
    cmd: join(root, EXACT_CLI),
    args: ['ios', '--no-install', ...(context.configuration === 'Release' ? ['--release'] : [])],
    cwd: root,
    env: {
      ...context.operation?.env,
      EXACT_SIM: udid,
      FORCE_COLOR: '0',
    },
    spawn: (file, args, opts) => getExecutor().spawn(file, args, opts),
    now: Date.now,
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
    onHeartbeat: context.note,
    logWriter: context.logWriter(),
    event: 'exact_build',
    label: 'build',
    estimateMs: context.estimates().coldBuildMs,
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
  const errors = [
    ...(run.error ? [`could not run ./${EXACT_CLI}: ${String(run.error)}`] : []),
    ...(!run.error && run.code === 0 ? [`./${EXACT_CLI} ios reported no built app with a bundle id`] : []),
    ...run.transcript.filter((line) => ERROR_LINE.test(line)),
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

function exactRecipe(root: string, context: IosArtifactContext): IosArtifactRecipe {
  return {
    buildTool: EXACT_CLI,
    identity: async () => ({ cacheIneligible: CACHE_INELIGIBLE }),
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
    compile: () => compile(root, context),
    explain: () => ({ reason: skippedMissReason(CACHE_INELIGIBLE), diff: null }),
    untrackedLine: () => null,
    expoCache: null,
    offload: null,
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
              detail: `stim ios builds with ./${EXACT_CLI} ios --no-install on the workspace's own simulator and launches it without Metro. Run Exact's own commands (test, agent) with EXACT_SIM set to that simulator.`,
              fix: null,
            },
          ],
  };
}
