import { maintenanceRunClaims, readMaintenanceState, type MaintenanceStatus } from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { resolveMaintenanceSettings } from './settings.ts';

export function maintenanceStatus(): MaintenanceStatus {
  const state = readMaintenanceState();
  const holder = readClaimSet(maintenanceRunClaims()).live[0];
  return {
    mode: resolveMaintenanceSettings()?.mode ?? 'off',
    lastChecks: {
      pressure: state?.lastAt.pressure ?? null,
      size: state?.lastAt.size ?? null,
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
    recent: state?.recent ?? [],
    plan: state?.plan ?? [],
  };
}

export function maintenanceLine(status: MaintenanceStatus): string | null {
  if (status.mode === 'off' && !status.lastPass && !status.running) return null;
  const at = status.lastPass
    ? new Date(status.lastPass.startedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const outputs = status.plan.filter((action) => action.kind === 'would-clear-outputs');
  const summary = outputs.length
    ? `would clear build outputs of ${outputs.length} ${outputs.length === 1 ? 'workspace' : 'workspaces'} (${(outputs.reduce((sum, action) => sum + action.bytes, 0) / 1024 ** 3).toFixed(1)} GB)`
    : `${status.plan.length} planned actions`;
  const disk = status.pressure?.disk
    .map((volume) => `disk ${(volume.freeMb / 1024).toFixed(1)} GB free on ${volume.volume}`)
    .join(', ');
  return `Auto maintenance (${status.mode === 'report' ? 'report only' : 'off'})${at ? ` ${at}` : ''}: ${status.lastPass ? summary : 'no pass has run yet'}${disk ? `; ${disk}` : ''}${status.running ? '; running' : ''}${status.lastPass?.blocked.length ? `; ${status.lastPass.blocked.join('; ')}` : ''}`;
}
