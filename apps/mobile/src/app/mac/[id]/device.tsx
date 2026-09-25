import { useLocalSearchParams } from 'expo-router';

import { DeviceView } from '@/screens/device-view';

export default function DeviceRoute() {
  const { path, platform, slot } = useLocalSearchParams<{ path: string; platform: 'ios' | 'android'; slot: string }>();
  return <DeviceView workspace={path} platform={platform === 'android' ? 'android' : 'ios'} slot={slot ?? 'default'} />;
}
