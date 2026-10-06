import { Redirect, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';
import { ReservedRegionsProvider } from 'react-native-reserved-regions';

import { useHasStatus, useMachinePresence, useMachineStatus, useWorkspace } from '@/hooks/machines';
import { archivedDeviceRoute } from '@/lib/archived';
import type { DevicePlatform } from '@/protocol/types';
import { DeviceView } from '@/screens/device-view';

export default function DeviceRoute() {
  const {
    id,
    path,
    platform,
    slot = 'default',
    physical,
    at,
  } = useLocalSearchParams<{
    id: string;
    path: string;
    platform: DevicePlatform;
    slot: string;
    physical?: string;
    at?: string;
  }>();
  const known = platform === 'android' || platform === 'web' || platform === 'macos' ? platform : 'ios';
  const loaded = useHasStatus(id);
  const cached = useMachinePresence(id).cached;
  const hasStatus = loaded && !cached;
  const status = useMachineStatus(id);
  const item = useWorkspace(id, path);
  const redirect = archivedDeviceRoute({
    macId: id,
    path,
    platform: known,
    slot,
    physical: physical === '1',
    at,
    hasStatus,
    workspaceListed: item !== undefined,
    archives: status?.archived ?? [],
  });
  if (redirect) return <Redirect href={redirect} />;
  const openAt = at === undefined ? undefined : Number(at);
  return (
    <ReservedRegionsProvider style={styles.root}>
      <DeviceView
        workspace={path}
        platform={known}
        slot={slot}
        physical={physical === '1'}
        openAt={Number.isNaN(openAt) ? undefined : openAt}
      />
    </ReservedRegionsProvider>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';

const styles = StyleSheet.create({ root: { flex: 1 } });
