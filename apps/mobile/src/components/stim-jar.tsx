import LottieView from 'lottie-react-native';
import { useEffect, useRef } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

const JAR_LIGHT = require('@/assets/animations/stim-jar-light.json');
const JAR_DARK = require('@/assets/animations/stim-jar-dark.json');

export function StimJar({ playing }: { playing: boolean }) {
  const dark = useColorScheme() === 'dark';
  const reduceMotion = useReducedMotion();
  const animate = playing && !reduceMotion;
  const ref = useRef<LottieView>(null);

  useEffect(() => {
    if (animate) ref.current?.resume();
    else ref.current?.pause();
  }, [animate, dark]);

  return <LottieView ref={ref} source={dark ? JAR_DARK : JAR_LIGHT} autoPlay={animate} loop style={styles.jar} />;
}

const styles = StyleSheet.create({
  jar: { width: 104, height: 168, marginBottom: 8 },
});
