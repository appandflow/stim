import type { StimContext } from '@stim-cli/core';
import type { ProjectPlanResult } from '../../integrations/project-plan.ts';
import { runProcessOperation } from '../../cli-operation.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { resolveProjectSettingsAsync } from '../../workspace/settings.ts';
import { projectRegistry } from '../../integrations/projects.ts';
import type { ProjectRegistry } from '../../integrations/project-registry.ts';
import { unsupportedPlan } from '../../integrations/project-plan.ts';
import { planFlagRefusal, printPlan, refusePlan } from '../build-plan.ts';
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
  wait?: string | boolean;
  metroCheck?: boolean;
}

export interface AndroidPlanDeps {
  findRoot: typeof findProjectRoot;
  projectRegistry: Pick<ProjectRegistry, 'selectAndroid'>;
}

function runOnlyFlag(opts: AndroidPlanOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.remote) return '--remote';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
}

export async function readAndroidBuildPlan(
  operation: StimContext,
  opts: AndroidPlanOptions,
  overrides: Partial<AndroidPlanDeps> = {},
): Promise<ProjectPlanResult> {
  const deps = { findRoot: findProjectRoot, projectRegistry, ...overrides };
  const flag = runOnlyFlag(opts);
  if (flag) return { refusal: planFlagRefusal(flag) };
  const root = deps.findRoot(operation.projectRoot);
  if (!root) return { refusal: NO_PROJECT_REFUSAL };
  const selected = deps.projectRegistry.selectAndroid(root);
  if ('problem' in selected) return { refusal: { code: 'STIM_NO_PROJECT', ...selected.problem } };
  const resolved = await resolveProjectSettingsAsync(root, { env: operation.env, signal: operation.signal });
  const project = await selected.load(resolved);
  const planner = project.plan;
  if (!planner) return { refusal: unsupportedPlan('android') };
  operation.signal.throwIfAborted();
  return planner(opts, resolved, operation);
}

export async function planAndroid(opts: AndroidPlanOptions, overrides: Partial<AndroidPlanDeps> = {}): Promise<void> {
  const json = Boolean(opts.json);
  const { value: result, interrupted } = await runProcessOperation(process.cwd(), (operation) =>
    readAndroidBuildPlan(operation, opts, overrides),
  );
  if ('platform' in result) printPlan(result, json);
  else refusePlan(result.refusal, json, result.lines);
  if (interrupted) process.exitCode = interrupted;
}
