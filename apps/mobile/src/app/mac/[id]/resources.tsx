import { useLocalSearchParams } from 'expo-router';

import { WorkspaceResources } from '@/screens/workspace-resources';

export default function ResourcesRoute() {
  const { path } = useLocalSearchParams<{ path: string }>();
  return <WorkspaceResources path={path} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
