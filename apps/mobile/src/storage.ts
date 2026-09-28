import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { createMMKV } from 'react-native-mmkv';

import { clearDerivedDataOnChange, runningMarker } from '@/lib/derived-data';

export const statusStorage = createMMKV({ id: 'stim.status' });
export const notificationStorage = createMMKV({ id: 'stim.notifications' });
/** View preferences, such as which Machine sections are folded; kept across updates. */
export const prefsStorage = createMMKV({ id: 'stim.prefs' });

clearDerivedDataOnChange(
  runningMarker(Constants.expoConfig?.version ?? null, Updates.runtimeVersion, Updates.updateId),
  { app: createMMKV({ id: 'stim.app' }), status: statusStorage, notifications: notificationStorage },
);
