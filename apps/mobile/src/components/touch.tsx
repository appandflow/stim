import { Platform, StyleSheet } from 'react-native';
import { Touchable, type TouchableProps } from 'react-native-gesture-handler';
import { withUnistyles } from 'react-native-unistyles';

import { useColors, type Colors } from '@/theme';

/**
 * How a `Touch` answers a press:
 * - `row`: a tinted underlay behind the content on iOS, a ripple on Android. For rows on a transparent background.
 * - `card`: a slight shrink on iOS, a ripple on Android, clipped to the border radius. For surfaces that set their own
 *   background, such as cards, chips and filled buttons, where an iOS underlay would be hidden behind the content.
 * - `opacity`: the content dims. For icon buttons, text buttons and toggles.
 */
type TouchFeedback = 'row' | 'card' | 'opacity';

const ThemedTouchable = withUnistyles(Touchable);

export type TouchProps = TouchableProps & { feedback?: TouchFeedback };

function feedbackProps(feedback: TouchFeedback, colors: Colors): Partial<TouchableProps> {
  const ripple = { color: `${colors.text}1F` };
  switch (feedback) {
    case 'row':
      return Platform.OS === 'android'
        ? { androidRipple: ripple }
        : { underlayColor: colors.primary, activeUnderlayOpacity: 0.1 };
    case 'card':
      return Platform.OS === 'android' ? { androidRipple: ripple } : { activeScale: 0.97 };
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
  const colors = useColors();
  return (
    <ThemedTouchable
      {...feedbackProps(feedback, colors)}
      accessible={accessible}
      accessibilityRole={accessibilityRole}
      accessibilityState={disabled ? { ...accessibilityState, disabled: true } : accessibilityState}
      accessibilityValue={accessibilityValue ?? stateValue(accessibilityRole, accessibilityState)}
      disabled={disabled}
      style={[feedback === 'card' && styles.clip, style]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
