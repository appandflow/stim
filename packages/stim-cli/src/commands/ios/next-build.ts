import type { StimContext } from '@stim-cli/core';
import { runProcessOperation } from '../../cli-operation.ts';
import { DEFAULT_DEPS } from './dependencies.ts';
import type { ProjectPlanResult } from '../../integrations/project-plan.ts';
import { NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { projectSettingsContextAsync } from '../../workspace/settings.ts';
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

export async function readIosBuildPlan(
  operation: StimContext,
  opts: IosCommandOptions,
  d: IosDeps = DEFAULT_DEPS,
): Promise<ProjectPlanResult> {
  const flag = runOnlyFlag(opts);
  if (flag) return { refusal: planFlagRefusal(flag) };
  const root = d.findProjectRoot(operation.projectRoot);
  if (!root) return { refusal: NO_PROJECT_REFUSAL };
  const selected = d.projectRegistry.selectIos(root);
  if ('problem' in selected) return { refusal: { code: 'STIM_NO_PROJECT', ...selected.problem } };
  const context = await projectSettingsContextAsync(root, d, { env: operation.env, signal: operation.signal });
  const settings = d.resolveSettings(context);
  const project = await selected.load(settings);
  if (!project.plan) return { refusal: unsupportedPlan('ios') };
  operation.signal.throwIfAborted();
  return project.plan(opts, { context, settings }, operation);
}

export async function planIos(opts: IosCommandOptions, d: IosDeps): Promise<void> {
  const json = Boolean(opts.json);
  const { value: result, interrupted } = await runProcessOperation(process.cwd(), (operation) =>
    readIosBuildPlan(operation, opts, d),
  );
  if ('platform' in result) printPlan(result, json);
  else refusePlan(result.refusal, json, result.lines);
  if (interrupted) process.exitCode = interrupted;
}
