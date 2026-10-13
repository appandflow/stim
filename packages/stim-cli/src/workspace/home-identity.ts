import { randomUUID } from 'node:crypto';
import { readHomeIdentity, withConfigLockAsync } from '@stim-cli/core/state';
import { ensureConfig, saveConfig } from './config.ts';

export function ensureHomeIdentity(signal?: AbortSignal): Promise<string> {
  return withConfigLockAsync(() => {
    signal?.throwIfAborted();
    const config = ensureConfig();
    const existing = readHomeIdentity(config);
    if (existing) return existing;
    const id = randomUUID();
    config.homeId = id;
    saveConfig(config);
    return id;
  });
}
