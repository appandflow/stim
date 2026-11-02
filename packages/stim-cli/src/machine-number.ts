import { isScopedHome } from '@stim-cli/core';
import { settingDefinition, settingValueError } from '@stim-cli/core/state';
import type { Config } from './workspace/config.ts';

function valueAt(source: unknown, key: string): unknown {
  let node = source;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function machineNumber(
  key: string,
  config: Config | null,
  env: NodeJS.ProcessEnv,
): { value: number | undefined; error: string | null } {
  const setting = settingDefinition(key)!;
  const fromEnv = setting.env ? env[setting.env] : undefined;
  if (fromEnv !== undefined && fromEnv !== '') {
    const value = fromEnv.trim() === '' ? Number.NaN : Number(fromEnv);
    const problem = settingValueError(setting, value);
    return problem
      ? { value: undefined, error: `Invalid ${setting.env} value ${JSON.stringify(fromEnv)}. Expected ${problem}.` }
      : { value, error: null };
  }
  if (isScopedHome(env) && typeof setting.scopedHomeValue === 'number')
    return { value: setting.scopedHomeValue, error: null };
  const raw = valueAt(config, key);
  if (raw === undefined)
    return { value: typeof setting.default === 'number' ? setting.default : undefined, error: null };
  const problem = settingValueError(setting, raw);
  return problem
    ? { value: undefined, error: `Invalid ${key} value ${JSON.stringify(raw)}. Expected ${problem}.` }
    : { value: raw as number, error: null };
}
