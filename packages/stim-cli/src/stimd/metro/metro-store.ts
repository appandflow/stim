import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metroCacheRoot, METRO_NAMED_CACHE_LAYOUT, registerCache } from '@stim-cli/core';

function metroStoreName(root: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const name = (pkg as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim() !== '') return name;
  } catch {}
  return 'app';
}

export function metroStoreRoot(root: string): string {
  return metroCacheRoot(metroStoreName(root));
}

export function registerMetroStore(storeRoot: string): void {
  const parent = resolve(metroCacheRoot());
  const dir = resolve(storeRoot);
  registerCache({
    dir,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
    note: 'shared Metro transforms, installed by stim start; no eviction of its own',
    replaces:
      dir === parent
        ? []
        : [
            {
              dir: parent,
              name: 'Metro transform cache',
              prune: 'entries',
              entriesDepth: 2,
              layout: null,
            },
          ],
  });
}

const EXPO_ADAPTER_FILE = 'expo-metro-config.cjs';

export function expoMetroConfigPath(fromUrl: string = import.meta.url): string | null {
  const here = dirname(fileURLToPath(fromUrl));
  for (const rel of ['./injected', '../../injected']) {
    const candidate = resolve(here, rel, EXPO_ADAPTER_FILE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const STORE_OK_PREFIX = 'stim-metro-store: sharing Metro transforms through ';

export function metroStoreConfirmedRoot(line: string): string | null {
  if (!line.startsWith(STORE_OK_PREFIX)) return null;
  const root = line.slice(STORE_OK_PREFIX.length).trim();
  return root === '' ? null : root;
}

export function expoMetroStoreEnv({
  root,
  port,
  storeRoot,
  adapterPath,
  existingOverride,
}: {
  root: string;
  port: number;
  storeRoot: string;
  adapterPath: string;
  existingOverride?: string | null;
}): Record<string, string> {
  return {
    EXPO_OVERRIDE_METRO_CONFIG: adapterPath,
    STIM_METRO_STORE: storeRoot,
    STIM_PROJECT_ROOT: root,
    STIM_METRO_PORT: String(port),
    ...(existingOverride ? { STIM_EXPO_METRO_CONFIG: existingOverride } : {}),
  };
}
