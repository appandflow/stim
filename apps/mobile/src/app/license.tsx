import { useLocalSearchParams } from 'expo-router';

import { License } from '@/screens/license';

export default function LicenseRoute() {
  const { index } = useLocalSearchParams<{ index: string }>();
  return <License index={Number(index)} />;
}
