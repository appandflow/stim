import { useLocalSearchParams } from 'expo-router';

import { BuildDetails } from '@/screens/build-details';

export default function BuildRoute() {
  const { path, platform, archive } = useLocalSearchParams<{
    path: string;
    archive?: string;
    platform: 'ios' | 'android' | 'macos';
  }>();
  return archive ? (
    <BuildDetails archive={archive} platform={platform} />
  ) : (
    <BuildDetails path={path} platform={platform} />
  );
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
