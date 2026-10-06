import { t } from '@lingui/core/macro';
import { useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import * as Updates from 'expo-updates';

import { updateCheckDue } from '@/lib/update-check';
import { updateStatus } from '@/lib/update-status';

export interface AppUpdateState {
  status: ReturnType<typeof updateStatus>;
}

export function useAppUpdate(): AppUpdateState {
  return { status: updateStatus(Updates.useUpdates()) };
}

/** Asks before restarting into the downloaded update, and reports a restart that fails. */
export function confirmRestartToUpdate(): void {
  Alert.alert(t`Restart to update?`, t`Stim restarts to apply the new version.`, [
    { text: t`Cancel`, style: 'cancel' },
    {
      text: t`Restart`,
      onPress: () => {
        Updates.reloadAsync().catch((error: unknown) =>
          Alert.alert(
            t`Could not restart`,
            error instanceof Error ? error.message : t`Try closing and reopening Stim.`,
          ),
        );
      },
    },
  ]);
}

let lastCheckedAt: number | null = null;
let running = false;

export async function checkForUpdateIfDue(): Promise<void> {
  const now = Date.now();
  if (!Updates.isEnabled || running || !updateCheckDue(lastCheckedAt, now)) return;
  lastCheckedAt = now;
  running = true;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) await Updates.fetchUpdateAsync();
  } catch {
  } finally {
    running = false;
  }
}

export function useForegroundUpdateCheck(): void {
  useEffect(() => {
    if (!Updates.isEnabled) return;
    // expo-updates checks on launch, so foreground and drawer checks wait for the next interval.
    lastCheckedAt = Date.now();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkForUpdateIfDue();
    });
    return () => subscription.remove();
  }, []);
}
