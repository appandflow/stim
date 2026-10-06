import { useLocalSearchParams } from 'expo-router';

import { ArchivedReplay } from '@/screens/archived-workspace';

export default function ArchiveReplayRoute() {
  const { archive, platform, at } = useLocalSearchParams<{
    archive: string;
    platform: 'ios' | 'android' | 'web';
    at?: string;
  }>();
  const openAt = at === undefined ? undefined : Number(at);
  return <ArchivedReplay archive={archive} platform={platform} openAt={Number.isNaN(openAt) ? undefined : openAt} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
