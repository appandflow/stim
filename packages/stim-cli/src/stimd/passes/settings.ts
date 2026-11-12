import { SETTINGS, machineSettingValue, loadConfig, type Config, type MaintenanceMode } from '@stim-cli/core/state';
import { daemonMode } from '../../daemon/mode.ts';

const PER_WORKSPACE = new Set(['maintenance.keep', 'maintenance.idleStopHours']);

/** The automatic maintenance settings; `mode` is `daemon.mode`, off while one of them is invalid. */
export interface MaintenanceSettings {
  mode: MaintenanceMode;
  invalid?: string;
  logMaxMb: number;
  logRetentionDays: number;
  logChecks: boolean;
  workspaceOutputsMaxGb: number;
  cargoTargetMaxGb: number;
  buildCacheMaxGb: number;
  metroCacheMaxGb: number;
  swiftCompilationCacheMaxGb: number;
  worktreeCheckMinutes: number;
  sweepHours: number;
  olderThanDays: number;
  protectRecentHours: number;
  removeFinishedWorktrees: boolean;
  removeIdleWorktrees: boolean;
  gradleVersionIdleDays: number;
}

export function resolveMaintenanceSettings(
  config: Config | null = loadConfig(),
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceSettings {
  const result: Record<string, unknown> = {};
  const invalid: string[] = [];
  let disabled = false;
  for (const setting of SETTINGS.filter(
    (entry) =>
      (entry.key.startsWith('maintenance.') && !PER_WORKSPACE.has(entry.key)) || /^caches\..*MaxGb$/.test(entry.key),
  )) {
    const [group, name] = setting.key.split('.') as [string, string];
    const { value, error } = machineSettingValue(setting.key, { config, env });
    if (error) {
      invalid.push(`${setting.key}: ${error}`);
      if (group === 'maintenance') disabled = true;
    }
    result[name] = error ? setting.default : value;
  }
  result.mode = disabled ? 'off' : daemonMode(env, config);
  if (invalid.length) result.invalid = invalid.join('; ');
  return result as unknown as MaintenanceSettings;
}
