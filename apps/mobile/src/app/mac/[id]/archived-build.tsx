import { useLocalSearchParams } from 'expo-router';

import { BuildDetails } from '@/screens/build-details';

export default function ArchiveRoute() {
  const { archive } = useLocalSearchParams<{ archive: string }>();
  return <BuildDetails archive={archive} platform="ios" />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
