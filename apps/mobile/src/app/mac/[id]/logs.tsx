import { useLocalSearchParams } from 'expo-router';

import { Logs } from '@/screens/logs';

export default function LogsRoute() {
  const { path, errors } = useLocalSearchParams<{ path: string; errors?: string }>();
  return <Logs path={path} errorsOnly={errors === '1'} />;
}
