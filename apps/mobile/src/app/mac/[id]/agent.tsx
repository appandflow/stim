import { useLocalSearchParams } from 'expo-router';

import type { DevicePlatform } from '@/protocol/types';
import { AgentActions } from '@/screens/agent-actions';

export default function AgentRoute() {
  const { path, platform, slot, device } = useLocalSearchParams<{
    path: string;
    platform: DevicePlatform;
    slot: string;
    device: string;
  }>();
  const known = platform === 'android' || platform === 'web' ? platform : 'ios';
  return <AgentActions path={path} platform={known} slot={slot ?? 'default'} deviceId={device} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
