import type { KeyValueStore } from '@/lib/status-cache';

export const MARKER_KEY = 'marker';
export const NOTIFY_STATE_KEY = 'state';
export const PUSHED_PREFIX = 'pushed:';

export interface DerivedDataStores {
  /** Holds the marker of the JS that last ran. */
  app: KeyValueStore;
  /** The status cache: every key is derived. */
  status: KeyValueStore;
  /** Notification settings and state: only the state and the push acceptances are derived. */
  notifications: KeyValueStore;
}

/** The running JS: the app version, the runtime and the update, so a new build, an OTA or a rollback differs. */
export function runningMarker(appVersion: string | null, runtimeVersion: string | null, updateId: string | null) {
  return JSON.stringify([appVersion, runtimeVersion, updateId]);
}

/**
 * Clears the data a previous JS derived when `marker` differs from the one it stored: the whole status cache, the
 * notification state and which machines accepted a push registration. Notification settings and the push token
 * stay, and so does everything in SecureStore. Returns whether it cleared.
 */
export function clearDerivedDataOnChange(marker: string, stores: DerivedDataStores): boolean {
  if (stores.app.getString(MARKER_KEY) === marker) return false;
  for (const key of stores.status.getAllKeys()) stores.status.remove(key);
  for (const key of stores.notifications.getAllKeys()) {
    if (key === NOTIFY_STATE_KEY || key.startsWith(PUSHED_PREFIX)) stores.notifications.remove(key);
  }
  stores.app.set(MARKER_KEY, marker);
  return true;
}
