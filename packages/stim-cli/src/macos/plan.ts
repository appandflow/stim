import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { MacosBuildPlanPayload } from '@stim-cli/core/state';
import { resolveBuildPlacement } from '../offload/selection.ts';
import { resolveProjectSettings, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { resolveBundleExtras, validateInfoPlist } from './stage.ts';

export function planMacos(root: string, buildMachineFlag?: string): MacosBuildPlanPayload {
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  if (!existsSync(join(root, 'Package.swift')))
    throw new Error('Run stim macos from the directory containing Package.swift.');
  const { context, settings } = resolveProjectSettings(root);
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
  validateInfoPlist(root, macos.product, macos.infoPlist);
  resolveBundleExtras(root, context.repoRoot ?? root, macos.resources, macos.assetCatalog);
  return {
    platform: 'macos',
    product: macos.product,
    buildMachine: selected.selected,
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    provider: null,
    cacheSkipped: false,
    prebuild: null,
    outcome: null,
    expectedMs: null,
    basis: 0,
  };
}
