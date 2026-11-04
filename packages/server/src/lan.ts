import { readFile } from 'node:fs/promises';
import { getConfigPath, isJsonObject } from '@stim-cli/core/state';

const REFRESH_MS = 5000;

/** `server.lanAddresses` from the machine config, or [] when it is unset, unreadable or not a list of strings. */
function parseLanAddresses(config: unknown): string[] {
  const server = isJsonObject(config) ? config.server : undefined;
  const value = isJsonObject(server) ? server.lanAddresses : undefined;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function readLanAddresses(): Promise<string[]> {
  try {
    return parseLanAddresses(JSON.parse(await readFile(getConfigPath(), 'utf8')));
  } catch {
    return [];
  }
}

function parseKeepAwake(config: unknown): boolean {
  const server = isJsonObject(config) ? config.server : undefined;
  return isJsonObject(server) && server.keepAwake === true;
}

async function readServerSettings(): Promise<{ lanAddresses: string[]; keepAwake: boolean }> {
  try {
    const config: unknown = JSON.parse(await readFile(getConfigPath(), 'utf8'));
    return { lanAddresses: parseLanAddresses(config), keepAwake: parseKeepAwake(config) };
  } catch {
    return { lanAddresses: [], keepAwake: false };
  }
}

/**
 * Keeps `server.lanAddresses` and `server.keepAwake` current without blocking: the Stim home can sit on a disk that
 * stops answering, so the settings are read asynchronously, one read at a time.
 */
export function watchServerSettings(refreshMs: number = REFRESH_MS): {
  current(): string[];
  keepAwake(): boolean;
  /** Calls `listener` after a read changes `server.keepAwake`; returns a function that removes it. */
  onKeepAwakeChange(listener: () => void): () => void;
  ready: Promise<void>;
  stop(): void;
} {
  let current: string[] = [];
  let keepAwake = false;
  let reading = false;
  const listeners = new Set<() => void>();
  const refresh = async () => {
    if (reading) return;
    reading = true;
    try {
      const next = await readServerSettings();
      current = next.lanAddresses;
      if (next.keepAwake !== keepAwake) {
        keepAwake = next.keepAwake;
        for (const listener of listeners) listener();
      }
    } finally {
      reading = false;
    }
  };
  const ready = refresh();
  const timer = setInterval(() => void refresh(), refreshMs);
  timer.unref();
  return {
    current: () => current,
    keepAwake: () => keepAwake,
    onKeepAwakeChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
    stop: () => clearInterval(timer),
  };
}
