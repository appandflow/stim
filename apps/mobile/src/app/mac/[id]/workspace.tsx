import { useLocalSearchParams } from 'expo-router';

import { WorkspaceDetail } from '@/screens/workspace-detail';

export default function WorkspaceRoute() {
  const { path, checkout } = useLocalSearchParams<{ path: string; checkout?: string }>();
  return <WorkspaceDetail path={path} scrollsToApp={checkout !== '1'} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
