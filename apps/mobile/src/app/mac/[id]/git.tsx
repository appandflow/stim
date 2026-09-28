import { useLocalSearchParams } from 'expo-router';

import { WorkspaceGit } from '@/screens/workspace-git';

export default function GitRoute() {
  const { path } = useLocalSearchParams<{ path: string }>();
  return <WorkspaceGit path={path} />;
}
