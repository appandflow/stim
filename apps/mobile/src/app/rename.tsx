import { useLocalSearchParams } from 'expo-router';

import { Rename } from '@/screens/rename';

export default function RenameRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Rename id={id} />;
}
