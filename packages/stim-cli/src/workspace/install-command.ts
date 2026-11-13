import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObject } from '@stim-cli/core/state';

const MANAGER_BY_LOCKFILE = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
} as const;

const MANAGER_LOCKS = Object.entries(MANAGER_BY_LOCKFILE);

export function packageManagerInstall(installRoot: string, mode: 'replace'): string;
export function packageManagerInstall(installRoot: string, mode: 'refresh'): string | null;
export function packageManagerInstall(installRoot: string, mode: 'replace' | 'refresh'): string | null {
  const managers = new Set(
    MANAGER_LOCKS.filter(([file]) => existsSync(join(installRoot, file))).map(([, manager]) => manager),
  );
  const [manager] = managers;
  if (mode === 'refresh') {
    if (!manager || managers.size !== 1) return null;
    const declared = readJsonObject(join(installRoot, 'package.json'))?.packageManager;
    return typeof declared !== 'string' || declared.startsWith(`${manager}@`) ? `${manager} install` : null;
  }
  return manager === 'npm' ? 'npm ci' : `${manager ?? 'npm'} install`;
}
