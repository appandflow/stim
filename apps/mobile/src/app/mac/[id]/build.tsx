import { useLocalSearchParams } from 'expo-router';

import { BuildDetails } from '@/screens/build-details';

export default function BuildRoute() {
  const { path, platform } = useLocalSearchParams<{ path: string; platform: 'ios' | 'android' }>();
  return <BuildDetails path={path} platform={platform} />;
}
