import type { KeyValueStore } from '@/lib/status-cache';

export const MARKER_KEY = 'marker';
export const NOTIFY_STATE_KEY = 'state';

export interface DerivedDataStores {
  /** Holds the marker of the JS that last ran. */
  app: KeyValueStore;
  /** The status cache: every key is derived. */
  status: KeyValueStore;
  /** Notification settings and state: only the state is derived. */
  notifications: KeyValueStore;
}

/** The running JS: the app version, the runtime and the update, so a new build, an OTA or a rollback differs. */
export function runningMarker(appVersion: string | null, runtimeVersion: string | null, updateId: string | null) {
  return JSON.stringify([appVersion, runtimeVersion, updateId]);
}

/**
 * Clears the data a previous JS derived when `marker` differs from the one it stored: the whole status cache and
 * the notification state. Notification settings, the push token, push registrations and the inbox's read state stay,
 * and so does everything in SecureStore.
 */
export function clearDerivedDataOnChange(marker: string, stores: DerivedDataStores): void {
  if (stores.app.getString(MARKER_KEY) === marker) return;
  for (const key of stores.status.getAllKeys()) stores.status.remove(key);
  stores.notifications.remove(NOTIFY_STATE_KEY);
  stores.app.set(MARKER_KEY, marker);
}
