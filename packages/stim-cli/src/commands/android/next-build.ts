import { findProjectRoot, NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { resolveProjectSettings } from '../../workspace/settings.ts';
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

export async function planAndroid(opts: AndroidPlanOptions, overrides: Partial<AndroidPlanDeps> = {}): Promise<void> {
  const deps = { findRoot: findProjectRoot, projectRegistry, ...overrides };
  const json = Boolean(opts.json);
  const flag = runOnlyFlag(opts);
  if (flag) return refusePlan(planFlagRefusal(flag), json);
  const root = deps.findRoot(process.cwd());
  if (!root) return refusePlan(NO_PROJECT_REFUSAL, json);
  const selected = deps.projectRegistry.selectAndroid(root);
  if ('problem' in selected) return refusePlan({ code: 'STIM_NO_PROJECT', ...selected.problem }, json);
  const resolved = resolveProjectSettings(root);
  const project = await selected.load(resolved);
  if (!project.plan) return refusePlan(unsupportedPlan('android'), json);
  const result = await project.plan(opts, resolved);
  if ('platform' in result) printPlan(result, json);
  else refusePlan(result.refusal, json, result.lines);
}
