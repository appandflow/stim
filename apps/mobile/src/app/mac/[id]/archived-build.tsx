import { useLocalSearchParams } from 'expo-router';

import { ArchivedBuild } from '@/screens/archived-workspace';

export default function ArchiveRoute() {
  const { archive } = useLocalSearchParams<{ archive: string }>();
  return <ArchivedBuild archive={archive} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
