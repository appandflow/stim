import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { configDir } from '@stim-cli/core';
import { readStimHomes, stimHomesFile, stimHomesLock, stimHomesRoot, type StimHomeEntry } from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { withDirLock } from '../dir-lock.ts';
import { STIM_HOMES_TEST_GUARD_ROOT_ENV } from './eas-machine-root-guard-env.ts';

export { stimHomesRoot } from '@stim-cli/core/state';

/** A home's last-seen time moves forward at most this often, so a busy home does not rewrite the list on every command. */
const LAST_SEEN_REFRESH_MS = 10 * 60_000;

type HomeDevices = StimHomeEntry['devices'];

function assertStimHomesRootWritable(root: string): void {
  const guardedRoot = process.env[STIM_HOMES_TEST_GUARD_ROOT_ENV];
  if (!guardedRoot || resolve(root) !== resolve(guardedRoot)) return;
  throw new Error(
    `Refusing to write the real machine list of Stim homes ${root} from a test process. Pass a temporary root, or point HOME (and USERPROFILE on Windows) at a temporary directory.`,
  );
}

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

/**
 * Whether the machine list tracks `home`: a home other than the default `~/.stim` and not one inside it. The default
 * home is the one that reports the others; the private homes stim-server and the build worker keep under it are
 * covered by the hosted sections of `gc`.
 */
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

/**
 * Lists `home` in the machine list, or refreshes its entry: the first call creates it, a later call moves its
 * last-seen time forward when that is older than ten minutes and, when `devices` is given, replaces its recorded
 * devices. Throws when the list is unreadable or `root` is the guarded real root.
 */
export function recordStimHome(
  home: string,
  { devices, now = Date.now(), root = stimHomesRoot() }: { devices?: HomeDevices; now?: number; root?: string } = {},
): void {
  assertStimHomesRootWritable(root);
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

/** Removes each listed home for which `when` still holds under the lock; returns the paths removed. */
export function forgetStimHomes(
  paths: readonly string[],
  when: (entry: StimHomeEntry) => boolean,
  root: string = stimHomesRoot(),
): string[] {
  assertStimHomesRootWritable(root);
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

const noted = new Map<string, number>();

/**
 * Lists the current Stim home when it creates a workspace or a device. Bookkeeping only: a list that cannot be read or
 * written leaves the command's own work untouched and is recorded in the debug log. Without `devices` it does
 * nothing more than a refresh of the last-seen time, at most once per refresh interval in this process.
 */
export function noteStimHome(devices?: HomeDevices, now: number = Date.now()): void {
  try {
    const home = canonical(configDir());
    if (!isTrackedStimHome(home)) return;
    const key = `${stimHomesRoot()}\0${home}`;
    if (!devices && now - (noted.get(key) ?? -Infinity) < LAST_SEEN_REFRESH_MS) return;
    recordStimHome(home, { devices, now });
    noted.set(key, now);
  } catch (error) {
    debugLog.log('home-registry.note-failed', { message: error instanceof Error ? error.message : String(error) });
  }
}
