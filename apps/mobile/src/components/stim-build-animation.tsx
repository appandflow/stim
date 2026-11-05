import LottieView from 'lottie-react-native';
import { useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { buildAnimationLayers } from '@/lib/build-animation';

const BUILD_LIGHT = require('@/assets/animations/stim-build-light.json');
const BUILD_DARK = require('@/assets/animations/stim-build-dark.json');
const BUILT_FRAME = 68;

export function StimBuildAnimation({ platform }: { platform: string }) {
  const dark = useColorScheme() === 'dark';
  const reduceMotion = useReducedMotion();
  const source = useMemo(() => {
    const asset = dark ? BUILD_DARK : BUILD_LIGHT;
    return { ...asset, layers: buildAnimationLayers(asset.layers, platform) };
  }, [dark, platform]);
  const progress = (BUILT_FRAME - source.ip) / (source.op - source.ip);

  return (
    <LottieView
      key={reduceMotion ? 'still' : 'playing'}
      source={source}
      autoPlay={!reduceMotion}
      loop={!reduceMotion}
      progress={reduceMotion ? progress : undefined}
      style={styles.animation}
    />
  );
}

const styles = StyleSheet.create({
  animation: { width: 56, height: 84 },
});
