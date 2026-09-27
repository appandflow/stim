import { useLocalSearchParams } from 'expo-router';

import type { DevicePlatform } from '@/protocol/types';
import { DeviceView } from '@/screens/device-view';

export default function DeviceRoute() {
  const { path, platform, slot } = useLocalSearchParams<{ path: string; platform: DevicePlatform; slot: string }>();
  const known = platform === 'android' || platform === 'web' ? platform : 'ios';
  return <DeviceView workspace={path} platform={known} slot={slot ?? 'default'} />;
}
