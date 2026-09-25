import { useLocalSearchParams } from 'expo-router';

import { BuildMiss } from '@/screens/build-miss';

export default function BuildMissRoute() {
  const { path, platform } = useLocalSearchParams<{ path: string; platform: 'ios' | 'android' }>();
  return <BuildMiss path={path} platform={platform} />;
}
