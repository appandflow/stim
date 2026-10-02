import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';
import { ReservedRegionsProvider } from 'react-native-reserved-regions';

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
  return (
    <ReservedRegionsProvider style={styles.root}>
      <DeviceView workspace={path} platform={known} slot={slot ?? 'default'} physical={physical === '1'} />
    </ReservedRegionsProvider>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';

const styles = StyleSheet.create({ root: { flex: 1 } });
