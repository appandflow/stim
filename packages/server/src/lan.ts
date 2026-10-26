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

/**
 * Keeps `server.lanAddresses` current without blocking: the Stim home can sit on a disk that stops answering, so the
 * setting is read asynchronously, one read at a time.
 */
export function watchLanAddresses(refreshMs: number = REFRESH_MS): {
  current(): string[];
  ready: Promise<void>;
  stop(): void;
} {
  let current: string[] = [];
  let reading = false;
  const refresh = async () => {
    if (reading) return;
    reading = true;
    try {
      current = await readLanAddresses();
    } finally {
      reading = false;
    }
  };
  const ready = refresh();
  const timer = setInterval(() => void refresh(), refreshMs);
  timer.unref();
  return { current: () => current, ready, stop: () => clearInterval(timer) };
}
