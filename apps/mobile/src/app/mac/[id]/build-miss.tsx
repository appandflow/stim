import { useLocalSearchParams } from 'expo-router';

import { BuildMiss } from '@/screens/build-miss';

export default function BuildMissRoute() {
  const { path, platform, next } = useLocalSearchParams<{ path: string; platform: 'ios' | 'android'; next?: string }>();
  return <BuildMiss path={path} platform={platform} next={next === '1'} />;
}
