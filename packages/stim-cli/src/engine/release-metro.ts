import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expoSdkMajor } from '../stimd/metro/server-expo.ts';
import { expoMetroConfigPath } from '../stimd/metro/metro-store.ts';

export async function withReleaseMetroCache<T>(
  root: string,
  release: boolean,
  env: NodeJS.ProcessEnv,
  build: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const sdk = release ? expoSdkMajor(root) : null;
  if (sdk === null || sdk < 54 || sdk >= 58) return build(env);
  const adapter = expoMetroConfigPath();
  if (!adapter) throw new Error('Stim installation is missing dist/injected/expo-metro-config.cjs.');
  // https://github.com/appandflow/stim/issues/4600: Expo ignores resetCache in CI before SDK 58.
  const store = await fs.mkdtemp(join(tmpdir(), 'stim-release-metro-'));
  try {
    return await build({
      ...env,
      EXPO_OVERRIDE_METRO_CONFIG: adapter,
      STIM_PROJECT_ROOT: root,
      STIM_METRO_STORE: store,
      STIM_METRO_ISOLATED: '1',
      ...(env.EXPO_OVERRIDE_METRO_CONFIG ? { STIM_EXPO_METRO_CONFIG: env.EXPO_OVERRIDE_METRO_CONFIG } : {}),
    });
  } finally {
    await fs.rm(store, { recursive: true, force: true });
  }
}
