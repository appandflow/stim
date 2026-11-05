import { Redirect } from 'expo-router';

import { NoiseCheck } from '@/screens/noise-check';

export default function NoiseCheckRoute() {
  return __DEV__ ? <NoiseCheck /> : <Redirect href="/" />;
}
