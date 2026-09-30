import { plural, t } from '@lingui/core/macro';

import { activityLabel, buildProgress, outcomeLabel, spokenDuration } from '@/lib/format';
import { devicesOf, platformName, runningBuild, type DeviceRef } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState } from '@/protocol/types';

/** A device's name on a workspace row: its platform, and its slot when it is not the default one. */
export const deviceTitle = (d: Pick<DeviceRef, 'platform' | 'slot'>) =>
  `${platformName(d.platform)}${d.slot === 'default' ? '' : ` \u00B7 ${d.slot}`}`;

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

/**
 * What a workspace row shows beyond its title, as spoken labels: error and warning counts first, then the running
 * build, Metro, each running device with its activity, and remote EAS sessions. `now` is the moment the row's times count to.
 */
export function workspaceStatusLabels(env: EnvironmentState, now: number): string[] {
  const parts: (string | null)[] = [];
  const errors = env.logs?.errorsSinceMarker ?? 0;
  if (errors > 0) parts.push(plural(errors, { one: '# error', other: '# errors' }));
  const warnings = env.warnings.length;
  if (warnings > 0) {
    const issues = env.issues?.some((issue) => issue.severity === 'error') ?? false;
    parts.push(
      issues
        ? plural(warnings, { one: '# issue', other: '# issues' })
        : plural(warnings, { one: '# warning', other: '# warnings' }),
    );
  }
  const build = runningBuild(env);
  if (build) parts.push(buildLabel(build, now));
  if (env.metro?.running) {
    const { port } = env.metro;
    parts.push(t`Metro running on port ${port}`);
  }
  if (env.supervisor && !env.supervisor.healthy) parts.push(t`supervisor unhealthy`);
  for (const d of devicesOf(env).filter((device) => device.running)) {
    const platform = platformName(d.platform);
    const name = d.slot === 'default' ? platform : t`${platform} ${d.slot}`;
    const activity = activityLabel(d.activity, now);
    parts.push(activity ? t`${name}, ${activity}` : t`${name} running`);
  }
  const sessions = env.remoteDevices?.length ?? 0;
  if (sessions > 0) parts.push(plural(sessions, { one: '# EAS session', other: '# EAS sessions' }));
  return parts.filter((part): part is string => Boolean(part));
}

/** What a devices grid tile shows beyond its model, workspace and machine, as spoken labels. */
export function deviceTileStatusLabels(device: DeviceRef, now: number): string[] {
  return [
    activityLabel(device.activity, now),
    device.physical ? t`Physical device` : null,
    device.page?.error ? t`Page failed to load` : null,
  ].filter((part): part is string => Boolean(part));
}
