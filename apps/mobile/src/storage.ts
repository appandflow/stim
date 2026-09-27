import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { createMMKV } from 'react-native-mmkv';

import { clearDerivedDataOnChange, runningMarker } from '@/lib/derived-data';

export const statusStorage = createMMKV({ id: 'stim.status' });
export const notificationStorage = createMMKV({ id: 'stim.notifications' });

clearDerivedDataOnChange(
  runningMarker(Constants.expoConfig?.version ?? null, Updates.runtimeVersion, Updates.updateId),
  { app: createMMKV({ id: 'stim.app' }), status: statusStorage, notifications: notificationStorage },
);
