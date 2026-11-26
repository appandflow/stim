import { iosHostRefusal, iosLocalBuildHostRefusal } from './support.ts';
import { automaticBuild } from '../../build-placement.ts';
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

export async function readIosBuildPlan(
  operation: StimContext,
  opts: IosCommandOptions,
  d: IosDeps = DEFAULT_DEPS,
): Promise<ProjectPlanResult> {
  const plan = await readBuildPlan('ios', operation, opts, runOnlyFlag(opts), {
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
  const host = d.hostPlatform();
  if (!('platform' in plan) || host === 'darwin') return plan;
  const easProfile = opts.easProfile !== undefined;
  const preference = plan.buildPlacement?.preference ?? 'auto';
  const offloads = !easProfile && !plan.cacheHit && automaticBuild(preference);
  const { buildPlacementCandidates } = await import('../../offload/client.ts');
  const refusal = (plan.placement ?? '').startsWith('this machine')
    ? iosHostRefusal(host)
    : (iosLocalBuildHostRefusal(host, preference, easProfile) ??
      (offloads && buildPlacementCandidates(preference, false).machines.length === 0
        ? iosHostRefusal(host, true)
        : null));
  if (refusal) return { ...plan, outcome: null, expectedMs: null, basis: 0, refusal };
  return offloads
    ? {
        ...plan,
        buildPlacement: {
          preference,
          reason: 'builds on an approved Mac chosen at run time; this machine cannot build iOS',
        },
      }
    : plan;
}

export function planIos(opts: IosCommandOptions, d: IosDeps): Promise<void> {
  return planBuild(opts, (operation) => readIosBuildPlan(operation, opts, d));
}
