export interface AppUpdateState {
  /** Whether a downloaded update is waiting for a restart to apply. */
  ready: boolean;
}

/**
 * Whether an EAS Update has downloaded and is waiting for a restart. Returns `ready: false` until `expo-updates`
 * is added to the app; once it lands, wire this hook to its `isUpdatePending` state.
 */
export function useAppUpdate(): AppUpdateState {
  return { ready: false };
}
