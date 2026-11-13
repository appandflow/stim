import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function packageManagerInstall(installRoot: string, { clean = false }: { clean?: boolean } = {}): string {
  if (existsSync(join(installRoot, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (existsSync(join(installRoot, 'yarn.lock'))) return 'yarn install';
  if (existsSync(join(installRoot, 'bun.lock')) || existsSync(join(installRoot, 'bun.lockb'))) return 'bun install';
  return clean && existsSync(join(installRoot, 'package-lock.json')) ? 'npm ci' : 'npm install';
}
