import { useLocalSearchParams } from 'expo-router';

import { WorkspaceWork } from '@/screens/workspace-work';

export default function WorkRoute() {
  const { path, archive } = useLocalSearchParams<{ path: string; archive?: string }>();
  return <WorkspaceWork path={path} archive={archive} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
