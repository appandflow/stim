import { useLocalSearchParams } from 'expo-router';

import { ArchivedReplay } from '@/screens/archived-workspace';

export default function ArchiveReplayRoute() {
  const { archive, platform } = useLocalSearchParams<{ archive: string; platform: 'ios' | 'android' | 'web' }>();
  return <ArchivedReplay archive={archive} platform={platform} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
