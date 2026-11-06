import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { configDir } from '@stim-cli/core';
import { readStimHomes, stimHomesFile, stimHomesLock, stimHomesRoot, type StimHomeEntry } from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { withDirLock } from '../dir-lock.ts';

export { stimHomesRoot } from '@stim-cli/core/state';

const LAST_SEEN_REFRESH_MS = 10 * 60_000;

type HomeDevices = StimHomeEntry['devices'];

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isTrackedStimHome(home: string): boolean {
  const defaultHome = canonical(join(homedir(), '.stim'));
  return home !== defaultHome && !inside(defaultHome, home);
}

function writeHomes(root: string, homes: Map<string, StimHomeEntry>): void {
  mkdirSync(root, { recursive: true });
  const file = stimHomesFile(root);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const entries = Object.fromEntries(
    [...homes].map(([path, { createdAt, lastSeenAt, devices }]) => [path, { createdAt, lastSeenAt, devices }]),
  );
  writeFileSync(tmp, `${JSON.stringify({ version: 1, homes: entries }, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function recordStimHome(
  home: string,
  { devices, now = Date.now(), root = stimHomesRoot() }: { devices?: HomeDevices; now?: number; root?: string } = {},
): void {
  withDirLock(
    stimHomesLock(root),
    () => {
      const current = readStimHomes(root);
      if (!current.safe) throw new Error(current.notice ?? 'The machine list of Stim homes is unreadable.');
      const stamp = new Date(now).toISOString();
      const existing = current.homes.get(home);
      const next: StimHomeEntry = existing
        ? { ...existing, devices: devices ?? existing.devices }
        : { path: home, createdAt: stamp, lastSeenAt: stamp, devices: devices ?? { ios: [], android: [] } };
      if (existing && now - Date.parse(existing.lastSeenAt) >= LAST_SEEN_REFRESH_MS) next.lastSeenAt = stamp;
      if (existing && JSON.stringify(next) === JSON.stringify(existing)) return;
      current.homes.set(home, next);
      writeHomes(root, current.homes);
    },
    { ensureParent: () => mkdirSync(dirname(stimHomesLock(root)), { recursive: true }) },
  );
}

export function forgetStimHomes(
  paths: readonly string[],
  when: (entry: StimHomeEntry) => boolean,
  root: string = stimHomesRoot(),
): string[] {
  return withDirLock(stimHomesLock(root), () => {
    const current = readStimHomes(root);
    if (!current.safe) return [];
    const removed = paths.filter((path) => {
      const entry = current.homes.get(path);
      return entry !== undefined && when(entry) && current.homes.delete(path);
    });
    if (removed.length) writeHomes(root, current.homes);
    return removed;
  });
}

const quietUntil = new Map<string, number>();
const FAILURE_BACKOFF_MS = 60_000;

export function noteStimHome(devices?: HomeDevices, now: number = Date.now()): void {
  let key: string | null = null;
  try {
    const home = canonical(configDir());
    if (!isTrackedStimHome(home)) return;
    key = `${stimHomesRoot()}\0${home}`;
    if (!devices && now < (quietUntil.get(key) ?? 0)) return;
    recordStimHome(home, { devices, now });
    quietUntil.set(key, now + LAST_SEEN_REFRESH_MS);
  } catch (error) {
    if (key && !devices) quietUntil.set(key, now + FAILURE_BACKOFF_MS);
    debugLog.log('home-registry.note-failed', { message: error instanceof Error ? error.message : String(error) });
  }
}
