import { useLocalSearchParams } from 'expo-router';

import { Rename } from '@/screens/rename';

export default function RenameRoute() {
  const { id, on } = useLocalSearchParams<{ id: string; on?: string }>();
  return <Rename id={id} on={on} />;
}
