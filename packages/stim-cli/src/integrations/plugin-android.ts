import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { androidProcessRuntime } from '../commands/android/launch.ts';
import { resolveVariant } from '../commands/android/support.ts';
import { planFlagRefusal, planPayload } from '../commands/build-plan.ts';
import { androidHome } from '../devices/android.ts';
import { validateDeviceSlot } from '../devices/device-slots.ts';
import { runCaptured } from '../engine/deps.ts';
import type { BuildAndroidResult } from '../engine/gradle.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { HEARTBEAT_INTERVAL_MS } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { ProjectPluginAndroidTarget } from '../project-plugin.ts';
import { workspaceDir } from '../workspace/paths.ts';
import type { AndroidProject } from './android-project.ts';
import { inspectApk } from './native-android-cache.ts';

const TAIL_LINES = 20;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// @ref LLP 0014#use-fixed-invocations -- the manifest's argument list runs as written, with no shell and nothing from the repository
export function pluginAndroidProject(
  root: string,
  plugin: { name: string; package: string },
  { build }: ProjectPluginAndroidTarget,
): AndroidProject {
  const uncached = `the plugin ${plugin.package} builds this ${plugin.name} project with its own command, on this machine and with no cache`;
  const variantProblem: AndroidProject['variantProblem'] = (variant) =>
    variant === null || variant === 'debug' || (variant === 'release' && build.release)
      ? null
      : {
          code: 'STIM_BAD_ARG',
          reason: `The plugin ${plugin.package} declares no Android build for the variant "${variant}".`,
          remedy: `Use ${build.release ? 'debug or release' : 'debug, the one variant it declares'}.`,
        };
  return {
    isExpo: false,
    packageRemedy: `Check the package name of the APK that the plugin ${plugin.package} builds.`,
    appIds: () => ({ bundleId: null, androidPackage: null }),
    variantProblem,
    targets: ['emulator'],
    eas: false,
    runtimeKind: () => 'process',
    plan: async (options, { context, settings }) => {
      if (options.easProfile !== undefined) return { refusal: planFlagRefusal('--eas-profile') };
      if (options.remote !== undefined) return { refusal: planFlagRefusal('--remote') };
      const refused = variantProblem(resolveVariant(options.variant, settings));
      if (refused) return { refusal: { code: refused.code, message: refused.reason, remedy: refused.remedy } };
      const planned = planPayload(
        {
          root,
          platform: 'android',
          slot: validateDeviceSlot(options.slot),
          projectKey: statsProjectKey({ root, commonDir: context.gitCommonDir, repoRoot: context.repoRoot }),
        },
        {
          fingerprint: null,
          cacheKey: null,
          cacheHit: false,
          cacheSkipped: false,
          provider: null,
          prebuild: null,
          missReason: skippedMissReason(uncached),
          refusal: null,
        },
      );
      return {
        ...planned,
        buildPlacement: {
          preference: options.remoteBuild ?? 'auto',
          reason: 'builds on this machine: a plugin build does not run on a build machine',
        },
      };
    },
    runtime: ({ phase }) =>
      androidProcessRuntime(async () => {
        phase('metro', 'skipped (native process)');
        return { ok: true, prepared: { metroPort: null } };
      }),
    artifact: ({ operation, writer, buildPlan, target, out, estimates }) => ({
      compiler: `the plugin ${plugin.package}`,
      identity: async () => ({ cacheIneligible: uncached }),
      cache: () => {
        throw new Error(uncached);
      },
      prepare: async () => {},
      reconcile: async () => ({ identity: null, rekeyedBy: [], cacheRefusal: null }),
      validate: async () => null,
      materialize: async () => null,
      explain: () => ({ reason: skippedMissReason(uncached), diff: null }),
      untrackedLine: () => null,
      expoCache: null,
      offload: null,
      compile: async (): Promise<BuildAndroidResult> => {
        if (!operation) throw new Error('A plugin Android build requires an operation context.');
        const signal = runCancellationSignal(operation) ?? operation.signal;
        const command = (buildPlan.release && build.release) || build.debug;
        const output = join(
          workspaceDir(root),
          'plugin-build',
          `android-${buildPlan.release ? 'release' : 'debug'}.apk`,
        );
        await mkdir(dirname(output), { recursive: true });
        await rm(output, { force: true });
        const [executable, ...declared] = command;
        const args = declared.map((arg) => (arg === '{root}' ? root : arg === '{output}' ? output : arg));
        const run = await runCaptured({
          cmd: executable,
          args,
          cwd: root,
          env: operation.env,
          spawn: (file, spawnArgs, options) => getExecutor().spawn(file, spawnArgs, options),
          now: Date.now,
          heartbeatMs: HEARTBEAT_INTERVAL_MS,
          onHeartbeat: out,
          logWriter: writer,
          event: 'plugin_build',
          label: 'build',
          estimateMs: estimates().coldBuildMs,
        });
        const failed = (reason: string, remedy: string): BuildAndroidResult => ({
          ok: false,
          code: 'STIM_BUILD_FAILED',
          reason,
          remedy,
          diagnostics: [],
          truncated: 0,
          lastLines: run.transcript.slice(-TAIL_LINES),
          durationMs: run.durationMs,
        });
        const manifest = `the Android build command in the package.json of the plugin ${plugin.package}`;
        if (run.error)
          return failed(
            `The plugin ${plugin.package} could not start ${executable}: ${message(run.error)}`,
            `Install ${executable} and put it on PATH, or correct ${manifest}.`,
          );
        if (run.code !== 0)
          return failed(
            `The Android build command of the plugin ${plugin.package} (${executable}) ${run.code === null ? `was stopped by ${run.signal ?? 'a signal'}` : `exited with code ${run.code}`}.`,
            `Read the build log, fix the ${plugin.name} project or ${manifest}, then retry.`,
          );
        if (!(await stat(output).catch(() => null))?.isFile())
          return failed(
            `The Android build command of the plugin ${plugin.package} (${executable}) exited with code 0 and wrote no APK at ${output}.`,
            `Check that ${manifest} writes its APK to the {output} argument.`,
          );
        try {
          const { androidPackage } = await inspectApk(
            output,
            androidHome(operation.env),
            target.abi,
            operation,
            signal,
          );
          return {
            ok: true,
            apkPath: output,
            apkNote: null,
            androidPackage,
            lastLines: run.transcript.slice(-TAIL_LINES),
            durationMs: run.durationMs,
          };
        } catch (error) {
          signal.throwIfAborted();
          return failed(
            `The APK that the plugin ${plugin.package} built could not be verified: ${message(error)}`,
            `Make ${manifest} write one signed, standalone APK for the emulator's ABI.`,
          );
        }
      },
    }),
  };
}
