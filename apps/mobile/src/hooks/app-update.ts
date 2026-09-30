import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

import { updateCheckDue } from '@/lib/update-check';

export interface AppUpdateState {
  /** Whether a downloaded update is waiting for a restart to apply. */
  ready: boolean;
}

/** Whether an EAS Update has downloaded and is waiting for a restart. */
export function useAppUpdate(): AppUpdateState {
  const { isUpdatePending } = Updates.useUpdates();
  return { ready: isUpdatePending };
}

async function downloadAvailableUpdate(): Promise<void> {
  try {
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) await Updates.fetchUpdateAsync();
  } catch {}
}

/**
 * Downloads a published EAS Update in the background whenever the app returns to the foreground. expo-updates
 * checks on launch itself, so this covers a resumed process, which never launches again.
 */
export function useForegroundUpdateCheck(): void {
  useEffect(() => {
    if (!Updates.isEnabled) return;
    let lastCheckedAt: number | null = Date.now();
    let running = false;
    const subscription = AppState.addEventListener('change', (state) => {
      const now = Date.now();
      if (state !== 'active' || running || !updateCheckDue(lastCheckedAt, now)) return;
      lastCheckedAt = now;
      running = true;
      void downloadAvailableUpdate().then(() => {
        running = false;
      });
    });
    return () => subscription.remove();
  }, []);
}
