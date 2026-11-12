import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { fingerprint, type EvalUncertain, type Fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

export const MOBILE_MODULES: string = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
export const SLOW = { timeout: 120_000 };
export const temps: string[] = [];
export let spawned: string[][] = [];

beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-eval-home-')));
  temps.push(home);
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  resetExecutor();
  spawned = [];
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A CNG Expo app outside any git work tree that installs nothing of its own: its node_modules is apps/mobile's, so
 * the evaluators run the Expo SDK, autolinking and expo-constants this repository installs.
 */
export function expoApp(
  files: Record<string, string>,
  dependencies: string[] = ['expo', 'expo-constants', 'react-native'],
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-eval-')));
  temps.push(root);
  const manifest = {
    name: 'fp-app',
    version: '1.0.0',
    dependencies: Object.fromEntries(dependencies.map((name) => [name, '*'])),
  };
  write(join(root, 'package.json'), JSON.stringify(manifest));
  write(join(root, 'pnpm-lock.yaml'), readFileSync(join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8'));
  write(
    join(root, 'app.json'),
    JSON.stringify({ expo: { name: 'fp', slug: 'fp', ios: { config: { usesNonExemptEncryption: false } } } }),
  );
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return root;
}

export const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  STIM_HOME: process.env.STIM_HOME,
  ...extra,
});

export function recordSpawns(): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      spawned.push([file, ...args]);
      return real.runFileAsync(file, args, options);
    },
  });
}

export async function key(
  root: string,
  env: NodeJS.ProcessEnv,
  embedMode: 'development' | 'production' = 'development',
  platform: 'ios' | 'android' = 'ios',
): Promise<Fingerprint> {
  const result = await fingerprint(root, { platform }, { env, embedMode });
  if (isUncertain(result)) throw new Error(JSON.stringify(result, null, 2));
  return result;
}

export async function refusal(root: string, env: NodeJS.ProcessEnv = baseEnv()): Promise<EvalUncertain> {
  const result = await fingerprint(root, { platform: 'ios' }, { env, embedMode: 'development' });
  if (!isUncertain(result)) throw new Error(`expected no key, got ${result.hash}`);
  return result;
}
