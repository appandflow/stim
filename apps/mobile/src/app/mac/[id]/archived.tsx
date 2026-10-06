import { useLocalSearchParams } from 'expo-router';

import { ArchivedWorkspace } from '@/screens/archived-workspace';

export default function ArchiveRoute() {
  const { archive } = useLocalSearchParams<{ archive: string }>();
  return <ArchivedWorkspace archive={archive} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
