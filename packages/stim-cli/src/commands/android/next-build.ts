import type { StimContext } from '@stim-cli/core';
import type { ProjectPlanResult } from '../../integrations/project-plan.ts';
import { runProcessOperation } from '../../cli-operation.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { resolveProjectSettingsAsync, type ResolvedProjectSettings } from '../../workspace/settings.ts';
import { projectRegistry } from '../../integrations/projects.ts';
import type { ProjectRegistry } from '../../integrations/project-registry.ts';
import { unsupportedPlan } from '../../integrations/project-plan.ts';
import { planFlagRefusal, plannedBuildPlacement, printPlan, refusePlan } from '../build-plan.ts';
import { resolveBuildPlacement } from '../../build-placement.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';

export interface AndroidPlanOptions {
  slot?: string;
  json?: boolean;
  easProfile?: string;
  buildCache?: boolean;
  variant?: string;
  systemImage?: string;
  deviceProfile?: string;
  device?: string | boolean;
  remote?: string;
  remoteBuild?: string;
  wait?: string | boolean;
  metroCheck?: boolean;
}

export interface AndroidPlanDeps {
  findRoot: typeof findProjectRoot;
  projectRegistry: Pick<ProjectRegistry, 'selectAndroid'>;
}

function runOnlyFlag(opts: AndroidPlanOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
}

interface BuildPlanDeps<Options> {
  findRoot: typeof findProjectRoot;
  select(root: string):
    | { problem: Extract<ReturnType<ProjectRegistry['selectAndroid']>, { problem: unknown }>['problem'] }
    | {
        load(resolved: ResolvedProjectSettings): Promise<{
          plan?(opts: Options, resolved: ResolvedProjectSettings, operation: StimContext): Promise<ProjectPlanResult>;
        }>;
      };
  resolve(root: string, operation: StimContext): Promise<ResolvedProjectSettings>;
}

export async function readBuildPlan<Options extends AndroidPlanOptions>(
  platform: 'ios' | 'android',
  operation: StimContext,
  opts: Options,
  flag: string | null,
  deps: BuildPlanDeps<Options>,
): Promise<ProjectPlanResult> {
  if (flag) return { refusal: planFlagRefusal(flag) };
  const root = deps.findRoot(operation.projectRoot);
  if (!root) return { refusal: NO_PROJECT_REFUSAL };
  const selected = deps.select(root);
  if ('problem' in selected) return { refusal: { code: 'STIM_NO_PROJECT', ...selected.problem } };
  const resolved = await deps.resolve(root, operation);
  const project = await selected.load(resolved);
  const planner = project.plan;
  if (!planner) return { refusal: unsupportedPlan(platform) };
  operation.signal.throwIfAborted();
  const build = resolveBuildPlacement(opts.remoteBuild);
  if (build.failure) return { refusal: build.failure };
  const options = { ...opts, remoteBuild: build.selected };
  const plan = await (platform === 'ios'
    ? planner.call(project, options, resolved, operation)
    : planner(options, resolved, operation));
  return 'platform' in plan ? plannedBuildPlacement(plan, build.selected, opts.easProfile !== undefined) : plan;
}

export function readAndroidBuildPlan(
  operation: StimContext,
  opts: AndroidPlanOptions,
  overrides: Partial<AndroidPlanDeps> = {},
): Promise<ProjectPlanResult> {
  const deps = { findRoot: findProjectRoot, projectRegistry, ...overrides };
  return readBuildPlan('android', operation, opts, runOnlyFlag(opts), {
    findRoot: deps.findRoot,
    select: (root) => deps.projectRegistry.selectAndroid(root),
    resolve: (root, context) => resolveProjectSettingsAsync(root, { env: context.env, signal: context.signal }),
  });
}

export async function planBuild<Options extends { json?: boolean }>(
  opts: Options,
  read: (operation: StimContext) => Promise<ProjectPlanResult>,
): Promise<void> {
  const json = Boolean(opts.json);
  const { value: result, interrupted } = await runProcessOperation(process.cwd(), read);
  if ('platform' in result) printPlan(result, json);
  else refusePlan(result.refusal, json, result.lines);
  if (interrupted) process.exitCode = interrupted;
}

export function planAndroid(opts: AndroidPlanOptions, overrides: Partial<AndroidPlanDeps> = {}): Promise<void> {
  return planBuild(opts, (operation) => readAndroidBuildPlan(operation, opts, overrides));
}
