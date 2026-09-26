import * as Updates from 'expo-updates';

export interface AppUpdateState {
  /** Whether a downloaded update is waiting for a restart to apply. */
  ready: boolean;
}

/** Whether an EAS Update has downloaded and is waiting for a restart. */
export function useAppUpdate(): AppUpdateState {
  const { isUpdatePending } = Updates.useUpdates();
  return { ready: isUpdatePending };
}
