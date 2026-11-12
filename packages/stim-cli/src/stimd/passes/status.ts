import {
  maintenanceRunClaims,
  readMaintenanceState,
  type MaintenanceCheck,
  type MaintenanceStatus,
} from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { formatBytes } from '../../fs-util.ts';
import { resolveMaintenanceSettings } from './settings.ts';

const CHECKS: readonly MaintenanceCheck[] = ['pressure', 'size', 'worktree', 'sweep', 'idle'];

export function maintenanceStatus(env: NodeJS.ProcessEnv = process.env): MaintenanceStatus {
  const state = readMaintenanceState();
  const claims = readClaimSet(maintenanceRunClaims());
  const holder = claims.live[0];
  const unresolved = claims.unresolved[0];
  const settings = resolveMaintenanceSettings(undefined, env);
  const deferred = CHECKS.flatMap((check) => {
    const since = state?.deferredSince?.[check];
    return since === undefined ? [] : [{ check, since }];
  });
  return {
    mode: settings.mode,
    ...(settings.invalid ? { invalid: settings.invalid } : {}),
    ...(unresolved
      ? {
          claim: {
            unresolved: `${unresolved.path}: ${unresolved.reason}`,
            removeCommand: claimRemoveCommand(unresolved.path),
          },
        }
      : {}),
    lastChecks: {
      pressure: state?.lastAt.pressure ?? null,
      size: state?.lastAt.size ?? null,
      worktree: state?.lastAt.worktree ?? null,
      sweep: state?.lastAt.sweep ?? null,
    },
    pressure: state?.pressure ?? null,
    sizes: state?.sizes ?? [],
    lastPass: state?.lastPass ?? null,
    running: holder
      ? {
          startedAt: holder.startedAt,
          trigger: String(holder.details.trigger ?? 'command'),
        }
      : null,
    ...(deferred.length ? { deferred } : {}),
    recent: state?.recent ?? [],
    plan: state?.plan ?? [],
  };
}

export function maintenanceLine(status: MaintenanceStatus, includeLabel = true): string | null {
  if (status.mode === 'off' && !status.lastPass && !status.running && !status.invalid && !status.claim) return null;
  const at = status.lastPass
    ? new Date(status.lastPass.startedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const outputs = status.plan.filter((action) => action.kind === 'would-clear-outputs');
  const summary =
    status.mode === 'on' && status.lastPass
      ? `${status.lastPass.actions} actions, ${(status.lastPass.freedBytes / 1024 ** 3).toFixed(1)} GB freed`
      : outputs.length
        ? `would clear build outputs of ${outputs.length} ${outputs.length === 1 ? 'workspace' : 'workspaces'} (${(outputs.reduce((sum, action) => sum + action.bytes, 0) / 1024 ** 3).toFixed(1)} GB)`
        : `${status.plan.length} planned actions`;
  const disk = status.pressure?.disk
    .map((volume) => `disk ${(volume.freeMb / 1024).toFixed(1)} GB free on ${volume.volume}`)
    .join(', ');
  const devices = status.sizes.filter((size) => size.category === 'owned-devices');
  const deviceDisk = devices.length
    ? `owned devices ${formatBytes(devices.reduce((sum, size) => sum + size.bytes, 0))}`
    : null;
  const culprits = (status.mode === 'off' ? undefined : status.pressure?.memory.culprits)
    ?.map(
      (culprit) =>
        `${culprit.name} uses ${formatBytes(culprit.bytes)}${culprit.command ? ` (\`${culprit.command}\`)` : ''}`,
    )
    .join(', ');
  return `${includeLabel ? 'Automatic maintenance: ' : ''}${at ? `${at}: ` : ''}${status.lastPass ? summary : 'no pass has run yet'}${disk ? `; ${disk}` : ''}${deviceDisk ? `; ${deviceDisk}` : ''}${culprits ? `; memory: ${culprits}` : ''}${status.running ? '; running' : ''}${deferredNote(status)}${status.lastPass?.blocked.length ? `; ${status.lastPass.blocked.join('; ')}` : ''}${status.invalid ? `; invalid: ${status.invalid}` : ''}${status.claim ? `; unresolved claim: ${status.claim.unresolved}; ${status.claim.removeCommand}` : ''}`;
}

function deferredNote(status: MaintenanceStatus): string {
  const first = status.deferred?.toSorted((a, b) => a.since - b.since)[0];
  if (!first) return '';
  const since = new Date(first.since).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `; ${status.deferred?.map(({ check }) => check).join(', ')} checks deferred for host load since ${since}`;
}

export function maintenanceLines(status: MaintenanceStatus): string[] {
  const line = maintenanceLine(status);
  return line === null ? [] : [line];
}
