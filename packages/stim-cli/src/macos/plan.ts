import type { StimContext } from '@stim-cli/core';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { MacosBuildPlanPayload } from '@stim-cli/core/state';
import { resolveBuildPlacement } from '../offload/selection.ts';
import { resolveProjectSettingsAsync, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';

export async function planMacos(
  context: StimContext,
  root: string,
  buildMachineFlag?: string,
): Promise<MacosBuildPlanPayload> {
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  if (!existsSync(join(root, 'Package.swift')))
    throw new Error('Run stim macos from the directory containing Package.swift.');
  const { settings } = await resolveProjectSettingsAsync(root, {
    env: context.env,
    signal: context.signal,
  });
  const [shape] = settingShapeErrors(settings);
  if (shape) throw new Error(`${shape} ${SETTING_SHAPE_REMEDY}`);
  const selected = resolveBuildPlacement(buildMachineFlag);
  if (selected.failure) throw Object.assign(new Error(selected.failure.message), selected.failure);
  const macos = settings.macos as
    | { product?: string; infoPlist?: string; resources?: unknown; assetCatalog?: unknown }
    | undefined;
  if (!macos?.product || !macos.infoPlist)
    throw Object.assign(
      new Error('Set macos.product and macos.infoPlist explicitly in .stim.json. See stim guide macos.'),
      { code: 'STIM_BAD_ARG' },
    );
  const { swiftpmMacosProject } = await import('../integrations/swiftpm-macos.ts');
  const recipe = await swiftpmMacosProject(root).prepare(context, settings);
  let identity: { hash: string; key: string } | null = null;
  let cacheHit = false;
  if (recipe.cache) {
    try {
      identity = await recipe.cache.identity();
      cacheHit = await recipe.cache.has(identity.key);
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) throw error;
      context.signal.throwIfAborted();
    }
  }
  return {
    platform: 'macos',
    product: macos.product,
    buildMachine: selected.selected,
    fingerprint: identity?.hash ?? null,
    cacheKey: identity?.key ?? null,
    cacheHit,
    provider: null,
    cacheSkipped: identity === null,
    prebuild: null,
    outcome: null,
    expectedMs: null,
    basis: 0,
  };
}
