import type { StimContext } from '@stim-cli/core';
import { readBuildPlan, planBuild } from '../android/next-build.ts';
import { DEFAULT_DEPS } from './dependencies.ts';
import type { ProjectPlanResult } from '../../integrations/project-plan.ts';
import { projectSettingsContextAsync } from '../../workspace/settings.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import type { IosDeps } from './dependencies.ts';
import type { IosCommandOptions } from './types.ts';

function runOnlyFlag(opts: IosCommandOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.installRuntime) return '--install-runtime';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.simulatorApp !== undefined) return '--simulator-app';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
}

export function readIosBuildPlan(
  operation: StimContext,
  opts: IosCommandOptions,
  d: IosDeps = DEFAULT_DEPS,
): Promise<ProjectPlanResult> {
  return readBuildPlan('ios', operation, opts, runOnlyFlag(opts), {
    findRoot: d.findProjectRoot,
    select: (root) => {
      const selected = d.projectRegistry.selectIos(root);
      return 'problem' in selected ? selected : { load: (resolved) => selected.load(resolved.settings) };
    },
    resolve: async (root, operationContext) => {
      const context = await projectSettingsContextAsync(root, d, {
        env: operationContext.env,
        signal: operationContext.signal,
      });
      return { context, settings: d.resolveSettings(context) };
    },
  });
}

export function planIos(opts: IosCommandOptions, d: IosDeps): Promise<void> {
  return planBuild(opts, (operation) => readIosBuildPlan(operation, opts, d));
}
