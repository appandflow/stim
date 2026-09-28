import { useLocalSearchParams } from 'expo-router';

import type { DevicePlatform } from '@/protocol/types';
import { DeviceView } from '@/screens/device-view';

export default function DeviceRoute() {
  const { path, platform, slot, physical } = useLocalSearchParams<{
    path: string;
    platform: DevicePlatform;
    slot: string;
    physical?: string;
  }>();
  const known = platform === 'android' || platform === 'web' ? platform : 'ios';
  return <DeviceView workspace={path} platform={known} slot={slot ?? 'default'} physical={physical === '1'} />;
}
