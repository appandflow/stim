import { NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { projectSettingsContext } from '../../workspace/settings.ts';
import { unsupportedPlan } from '../../integrations/project-plan.ts';
import { planFlagRefusal, printPlan, refusePlan } from '../build-plan.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import type { IosDeps } from './dependencies.ts';
import type { IosCommandOptions } from './types.ts';

function runOnlyFlag(opts: IosCommandOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.remote) return '--remote';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.simulatorApp !== undefined) return '--simulator-app';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
}

export async function planIos(opts: IosCommandOptions, d: IosDeps): Promise<void> {
  const json = Boolean(opts.json);
  const flag = runOnlyFlag(opts);
  if (flag) return refusePlan(planFlagRefusal(flag), json);
  const root = d.findProjectRoot(process.cwd());
  if (!root) return refusePlan(NO_PROJECT_REFUSAL, json);
  const selected = d.projectRegistry.selectIos(root);
  if ('problem' in selected) return refusePlan({ code: 'STIM_NO_PROJECT', ...selected.problem }, json);
  const context = projectSettingsContext(root, d);
  const settings = d.resolveSettings(context);
  const project = await selected.load(settings);
  if (!project.plan) return refusePlan(unsupportedPlan('ios'), json);
  const result = await project.plan(opts, { context, settings });
  if ('platform' in result) printPlan(result, json);
  else refusePlan(result.refusal, json, result.lines);
}
