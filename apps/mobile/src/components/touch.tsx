import { useState } from 'react';
import { Platform } from 'react-native';
import { EaseView, type Transition } from 'react-native-ease';
import { Touchable, type TouchableProps } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles, withUnistyles } from 'react-native-unistyles';

import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';

/**
 * How a `Touch` answers a press:
 * - `row`: a tinted underlay behind the content on iOS, a ripple on Android. For rows on a transparent background.
 * - `card`: the surface shrinks on press and springs back with a small bounce, plus a ripple on Android clipped to the
 *   border radius. With Reduce Motion, a plain shrink on iOS and only the ripple on Android. For surfaces that set their
 *   own background, such as cards, chips and filled buttons, where an iOS underlay would be hidden behind the content.
 * - `opacity`: the content dims. For icon buttons, text buttons and toggles.
 */
type TouchFeedback = 'row' | 'card' | 'opacity';

const PRESS_SCALE = 0.97;
const PRESS_IN: Transition = { type: 'timing', duration: 80, easing: 'easeOut' };
const PRESS_OUT: Transition = { type: 'spring', damping: 11, stiffness: 320, mass: 1 };

/** Style keys that place the card among its siblings. They move to the animated wrapper; the rest stays on the button. */
const PLACEMENT_KEYS = new Set([
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginHorizontal',
  'marginVertical',
  'marginStart',
  'marginEnd',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'position',
  'top',
  'bottom',
  'left',
  'right',
  'start',
  'end',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
  'zIndex',
]);

function splitStyle(style: object) {
  const placement: Record<string, unknown> = {};
  const surface: Record<string, unknown> = { flexGrow: 1, flexShrink: 1 };
  for (const [key, value] of Object.entries(style)) {
    (PLACEMENT_KEYS.has(key) ? placement : surface)[key] = value;
  }
  return { placement, surface };
}

/**
 * A `Touchable` inside an `EaseView` that scales the whole card. `EaseView` scales on the native thread, so the
 * bounce runs while the JS thread is busy. `Touchable` reports `onPressOut` when a press turns into a scroll, so the
 * card springs back without firing `onPress`.
 */
function BouncingTouchable({ style, onPressIn, onPressOut, ...props }: TouchableProps) {
  const reduceMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const { placement, surface } = splitStyle((style ?? {}) as object);
  return (
    <EaseView
      style={placement}
      animate={{ scale: pressed && !reduceMotion ? PRESS_SCALE : 1 }}
      transition={pressed ? PRESS_IN : PRESS_OUT}
    >
      <Touchable
        {...props}
        activeScale={reduceMotion && Platform.OS === 'ios' ? PRESS_SCALE : undefined}
        style={surface}
        onPressIn={(event) => {
          setPressed(true);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          setPressed(false);
          onPressOut?.(event);
        }}
      />
    </EaseView>
  );
}

const ThemedTouchable = withUnistyles(Touchable);
const ThemedBouncingTouchable = withUnistyles(BouncingTouchable);

export type TouchProps = TouchableProps & { feedback?: TouchFeedback };

function feedbackProps(feedback: TouchFeedback, theme: Theme): Partial<TouchableProps> {
  const ripple = { color: withAlpha(theme.colors.text, theme.opacity.pressed) };
  switch (feedback) {
    case 'row':
      return Platform.OS === 'android'
        ? { androidRipple: ripple }
        : { underlayColor: theme.colors.primary, activeUnderlayOpacity: theme.opacity.subtle };
    case 'card':
      return Platform.OS === 'android' ? { androidRipple: ripple } : {};
    case 'opacity':
      return { activeOpacity: 0.5, animationDuration: { in: 0, out: 150 } };
  }
}

/**
 * React Native's iOS view reports a checked switch as the value "1" or "0", which VoiceOver reads as on or off, and
 * an expanded element as "expanded". Gesture Handler's native button maps only `selected` and `disabled` from the
 * accessibility state.
 */
function stateValue(role: TouchProps['accessibilityRole'], state: TouchProps['accessibilityState']) {
  if (Platform.OS !== 'ios' || !state) return undefined;
  if (role === 'switch' && typeof state.checked === 'boolean') return { text: state.checked ? '1' : '0' };
  return state.expanded ? { text: 'expanded' } : undefined;
}

/** Gesture Handler's `Touchable` with the app's press feedback, exposed to assistive technology as one button. */
export function Touch({
  feedback = 'opacity',
  accessible = true,
  accessibilityRole = 'button',
  accessibilityState,
  accessibilityValue,
  disabled,
  style,
  ...props
}: TouchProps) {
  const { theme } = useUnistyles();
  // Unistyles' withUnistyles flattens a style array one level only, and drops the styles of any deeper array.
  const flatStyle = ([feedback === 'card' && styles.clip, style] as unknown[]).flat(Infinity) as TouchProps['style'];
  const Component = feedback === 'card' ? ThemedBouncingTouchable : ThemedTouchable;
  return (
    <Component
      {...feedbackProps(feedback, theme)}
      accessible={accessible}
      accessibilityRole={accessibilityRole}
      accessibilityState={disabled ? { ...accessibilityState, disabled: true } : accessibilityState}
      accessibilityValue={accessibilityValue ?? stateValue(accessibilityRole, accessibilityState)}
      disabled={disabled}
      style={flatStyle}
      {...props}
    />
  );
}

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
