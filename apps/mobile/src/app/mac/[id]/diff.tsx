import { useLocalSearchParams } from 'expo-router';

import { WorkspaceDiff } from '@/screens/workspace-diff';

export default function DiffRoute() {
  const { path, file, group } = useLocalSearchParams<{ path: string; file?: string; group?: string }>();
  return <WorkspaceDiff path={path} file={file} group={group === 'untracked' ? 'untracked' : 'changed'} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
