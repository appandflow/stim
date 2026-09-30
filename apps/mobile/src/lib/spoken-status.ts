import { t } from '@lingui/core/macro';

import { activityLabel, buildProgress, outcomeLabel, spokenDuration } from '@/lib/format';
import { platformName, type DeviceRef } from '@/lib/workspaces';
import type { BuildReport } from '@/protocol/types';

/** A running build as spoken: what it builds, the phase, how long it has run, its cache outcome and the time left. */
export function buildLabel(build: BuildReport, now: number): string {
  const progress = buildProgress(build, now);
  const platform = platformName(build.platform);
  const { slot } = build;
  const elapsed = spokenDuration(progress.elapsedMs);
  return [
    slot === 'default' ? t`Building ${platform}` : t`Building ${platform}, slot ${slot}`,
    build.phase,
    t`${elapsed} elapsed`,
    outcomeLabel(build),
    progress.remaining,
  ]
    .filter(Boolean)
    .join(', ');
}

/** What a devices grid tile shows beyond its model, workspace and machine, as spoken labels. */
export function deviceTileStatusLabels(device: DeviceRef, now: number): string[] {
  return [
    activityLabel(device.activity, now),
    device.physical ? t`Physical device` : null,
    device.page?.error ? t`Page failed to load` : null,
  ].filter((part): part is string => Boolean(part));
}
