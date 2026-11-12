import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { fingerprint, type Fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

export const MOBILE_MODULES: string = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const REPO_LOCK: string = join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml');
export const SLOW = { timeout: 120_000 };
export const LATER = 10_000_000_000n;

export let base: string;
let spawned: string[][] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-index-')));
  process.env.STIM_HOME = join(base, 'home');
  spawned = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      if (args.some((arg: string) => arg.endsWith('fp-trace.cjs'))) spawned.push([file, ...args]);
      return real.runFileAsync(file, args, options);
    },
  });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

export function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A CNG Expo app installing nothing of its own: its node_modules is apps/mobile's, with this repository's lockfile. */
export function expoApp(dir: string, files: Record<string, string> = {}): string {
  const root = join(base, dir);
  write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fp-app', version: '1.0.0', dependencies: { expo: '*', 'expo-constants': '*' } }),
  );
  write(join(root, 'pnpm-lock.yaml'), readFileSync(REPO_LOCK, 'utf8'));
  write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp' } }));
  write(
    join(root, 'app.config.js'),
    'module.exports = ({ config }) => ({ ...config, extra: { flag: process.env.APP_FLAG ?? null } });\n',
  );
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  const installed = new Date(Date.now() - 86_400_000);
  utimesSync(join(root, 'pnpm-lock.yaml'), installed, installed);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return realpathSync(root);
}

/** The racy guard trusts only files written more than 50 ms before a computation starts. */
export const settled = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 100));

export const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  STIM_HOME: process.env.STIM_HOME,
  ...extra,
});

export async function key(
  root: string,
  index: 'use' | 'skip' | 'refresh' = 'use',
  extra: NodeJS.ProcessEnv = {},
): Promise<Fingerprint> {
  const result = await fingerprint(root, { platform: 'ios' }, { env: env(extra), embedMode: 'development', index });
  if (isUncertain(result)) throw new Error(JSON.stringify(result));
  return result;
}

/** Which evaluator children ran since the last call: `config`, `resolve`, `react-native-config`, `embed`. */
export function ran(): string[] {
  const parts = spawned.map((argv) =>
    argv.includes('resolve')
      ? 'resolve'
      : argv.includes('react-native-config')
        ? 'react-native-config'
        : argv.includes('embed')
          ? 'embed'
          : argv.includes('expo')
            ? 'config'
            : argv.join(' '),
  );
  spawned = [];
  return parts.toSorted();
}
