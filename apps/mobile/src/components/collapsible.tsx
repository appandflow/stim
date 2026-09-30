import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { EaseView } from 'react-native-ease';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Icon } from '@/components/icon';
import { useUnistyles } from 'react-native-unistyles';

const DISCLOSURE_MS = 220;
const EASING = Easing.out(Easing.cubic);

/**
 * Content that folds open and closed: its height and opacity follow one timing while whatever sits below moves with
 * it. Closed content is unmounted once the fold ends. Under Reduce Motion it toggles at once.
 */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [previous, setPrevious] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const natural = useSharedValue(0);
  const folding = useSharedValue(false);

  if (open !== previous) {
    setPrevious(open);
    if (open || reduceMotion) setMounted(open);
  }

  const unmount = useCallback(() => setMounted(false), []);

  useEffect(() => {
    if (reduceMotion) {
      progress.set(open ? 1 : 0);
      folding.set(false);
      return;
    }
    folding.set(true);
    progress.set(
      withTiming(open ? 1 : 0, { duration: DISCLOSURE_MS, easing: EASING }, (finished) => {
        if (!finished) return;
        folding.set(false);
        if (!open) scheduleOnRN(unmount);
      }),
    );
  }, [open, reduceMotion, progress, folding, unmount]);

  const style = useAnimatedStyle(() =>
    folding.get()
      ? { height: natural.get() * progress.get(), opacity: progress.get() }
      : { height: 'auto', opacity: 1 },
  );

  if (!mounted) return null;
  return (
    <Animated.View style={[{ overflow: 'hidden' }, style]}>
      <View onLayout={(event) => natural.set(event.nativeEvent.layout.height)}>{children}</View>
    </Animated.View>
  );
}

/** A chevron that points right when closed and down when open, turning with the fold. */
export function DisclosureChevron({ open, size }: { open: boolean; size: number }) {
  const reduceMotion = useReducedMotion();
  const { theme } = useUnistyles();
  return (
    <EaseView
      animate={{ rotate: open ? 90 : 0 }}
      transition={reduceMotion ? { type: 'none' } : { type: 'timing', duration: DISCLOSURE_MS, easing: 'easeOut' }}
    >
      <Icon name="chevron.right" size={size} color={theme.colors.tertiary} />
    </EaseView>
  );
}
