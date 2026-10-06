import {
  SETTINGS,
  coerceSettingText,
  settingValueError,
  loadConfig,
  type Config,
  type MaintenanceMode,
} from '@stim-cli/core/state';

export interface MaintenanceSettings {
  mode: MaintenanceMode;
  invalid?: string;
  pressureCheckMinutes: number;
  sizeCheckMinutes: number;
  maxLoadPerCore: number;
  logMaxMb: number;
  logRetentionDays: number;
  logChecks: boolean;
  memoryPressureLevel: 'warning' | 'critical' | 'off';
  memoryWarningMinutes: number;
  minAvailableMemoryGb?: number;
  capTargetPercent: number;
  workspaceOutputsMaxGb: number;
  buildCacheMaxGb: number;
  metroCacheMaxGb: number;
  swiftCompilationCacheMaxGb: number;
}

export function resolveMaintenanceSettings(
  config: Config | null = loadConfig(),
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceSettings {
  const result: Record<string, unknown> = {};
  const invalid: string[] = [];
  let disabled = false;
  for (const setting of SETTINGS.filter(
    (entry) => entry.key.startsWith('maintenance.') || /^caches\..*MaxGb$/.test(entry.key),
  )) {
    const [group, name] = setting.key.split('.') as [string, string];
    const rawEnv = setting.env ? env[setting.env] : undefined;
    const layer = config?.[group];
    const configured = layer && typeof layer === 'object' ? (layer as Record<string, unknown>)[name] : undefined;
    const value =
      rawEnv !== undefined
        ? coerceSettingText(setting, rawEnv)
        : env.STIM_HOME && setting.scopedHomeValue !== undefined
          ? setting.scopedHomeValue
          : env.CI && setting.ciValue !== undefined
            ? setting.ciValue
            : configured === undefined
              ? setting.default
              : configured;
    const error = value === undefined ? null : settingValueError(setting, value);
    if (error) {
      invalid.push(`${setting.key}: expected ${error}`);
      if (group === 'maintenance') disabled = true;
    }
    result[name] = error ? setting.default : value;
  }
  if (disabled) result.mode = 'off';
  if (invalid.length) result.invalid = invalid.join('; ');
  return result as unknown as MaintenanceSettings;
}
