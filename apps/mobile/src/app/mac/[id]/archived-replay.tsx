import { useLocalSearchParams } from 'expo-router';

import { ArchivedReplay } from '@/screens/archived-replay';

export default function ArchiveReplayRoute() {
  const { archive, platform, at, slot } = useLocalSearchParams<{
    archive: string;
    platform: 'ios' | 'android' | 'web';
    at?: string;
    slot?: string;
  }>();
  const openAt = at === undefined ? undefined : Number(at);
  return (
    <ArchivedReplay
      archive={archive}
      platform={platform}
      slot={slot}
      openAt={Number.isNaN(openAt) ? undefined : openAt}
    />
  );
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
