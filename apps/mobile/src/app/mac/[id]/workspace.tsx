import { useLocalSearchParams } from 'expo-router';

import { WorkspaceDetail } from '@/screens/workspace-detail';

export default function WorkspaceRoute() {
  const { path } = useLocalSearchParams<{ path: string }>();
  return <WorkspaceDetail path={path} />;
}
