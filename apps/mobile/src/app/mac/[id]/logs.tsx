import { useLocalSearchParams } from 'expo-router';

import { Logs } from '@/screens/logs';

export default function LogsRoute() {
  const { path, ...params } = useLocalSearchParams<{
    path: string;
    errors?: string;
    source?: string;
    slot?: string;
    at?: string;
  }>();
  return <Logs path={path} params={params} />;
}
