import { useLocalSearchParams } from 'expo-router';

import { WorkspaceDetail } from '@/screens/workspace-detail';

export default function ArchiveRoute() {
  const { archive } = useLocalSearchParams<{ archive: string }>();
  return <WorkspaceDetail archive={archive} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
