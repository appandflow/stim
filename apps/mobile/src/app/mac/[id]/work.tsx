import { useLocalSearchParams } from 'expo-router';

import { WorkspaceWork } from '@/screens/workspace-work';

export default function WorkRoute() {
  const { path } = useLocalSearchParams<{ path: string }>();
  return <WorkspaceWork path={path} />;
}
