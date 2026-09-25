import { useLocalSearchParams } from 'expo-router';

import { MacStatus } from '@/screens/mac-status';

export default function MacStatusRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MacStatus id={id} />;
}
