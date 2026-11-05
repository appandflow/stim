import { useLocalSearchParams } from 'expo-router';

import { WorkspaceResources } from '@/screens/workspace-resources';

export default function ResourcesRoute() {
  const { path, archive } = useLocalSearchParams<{ path: string; archive?: string }>();
  return <WorkspaceResources path={path} archive={archive} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
