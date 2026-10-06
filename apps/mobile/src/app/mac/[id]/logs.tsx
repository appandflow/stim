import { useLocalSearchParams } from 'expo-router';

import { Logs } from '@/screens/logs';

export default function LogsRoute() {
  const { path, archive, ...params } = useLocalSearchParams<{
    path: string;
    archive?: string;
    errors?: string;
    source?: string;
    slot?: string;
    at?: string;
  }>();
  return <Logs path={path} archive={archive} params={params} />;
}

export { RouteErrorBoundary as ErrorBoundary } from '@/components/route-error-boundary';
