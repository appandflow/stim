import LottieView from 'lottie-react-native';
import { useEffect, useRef } from 'react';
import { View, useColorScheme } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import type { DevicePlatform } from '@/protocol/types';

const ANIMATIONS = {
  'device-boot-ios': {
    light: require('@/assets/animations/brand/device-boot-ios-light.json'),
    dark: require('@/assets/animations/brand/device-boot-ios-dark.json'),
    aspect: 220 / 275,
  },
  'device-boot-android': {
    light: require('@/assets/animations/brand/device-boot-android-light.json'),
    dark: require('@/assets/animations/brand/device-boot-android-dark.json'),
    aspect: 220 / 275,
  },
  'device-boot-web': {
    light: require('@/assets/animations/brand/device-boot-web-light.json'),
    dark: require('@/assets/animations/brand/device-boot-web-dark.json'),
    aspect: 220 / 275,
  },
  'device-boot-macos': {
    light: require('@/assets/animations/brand/device-boot-macos-light.json'),
    dark: require('@/assets/animations/brand/device-boot-macos-dark.json'),
    aspect: 220 / 275,
  },
};

type AnimationName = keyof typeof ANIMATIONS;

const DEVICE_WAIT_ANIMATIONS: Record<DevicePlatform, AnimationName> = {
  ios: 'device-boot-ios',
  android: 'device-boot-android',
  web: 'device-boot-web',
  macos: 'device-boot-macos',
};

export function deviceWaitAnimation(platform: DevicePlatform = 'ios'): AnimationName {
  return DEVICE_WAIT_ANIMATIONS[platform];
}

export function BrandAnimation({
  name,
  playing,
  width = 96,
  onDark = false,
}: {
  name: AnimationName;
  playing: boolean;
  width?: number;
  onDark?: boolean;
}) {
  const dark = useColorScheme() === 'dark' || onDark;
  const reduceMotion = useReducedMotion();
  const animate = playing && !reduceMotion;
  const ref = useRef<LottieView>(null);
  const animation = ANIMATIONS[name];

  useEffect(() => {
    if (animate) ref.current?.resume();
    else ref.current?.reset();
  }, [animate, dark, name]);

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <LottieView
        ref={ref}
        source={dark ? animation.dark : animation.light}
        autoPlay={animate}
        progress={animate ? undefined : 0}
        loop
        style={{ width, height: width / animation.aspect }}
      />
    </View>
  );
}
