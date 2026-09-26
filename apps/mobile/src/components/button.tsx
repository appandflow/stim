import { ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import type { Theme } from '@/design/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'small' | 'regular';

function labelTone(variant: ButtonVariant): TextTone {
  switch (variant) {
    case 'primary':
      return 'onBrand';
    case 'destructive':
      return 'error';
    default:
      return 'brand';
  }
}

function toneColor(theme: Theme, tone: TextTone): string {
  return tone === 'onBrand' ? theme.colors.onPrimary : tone === 'error' ? theme.colors.error : theme.colors.primary;
}

/** A text button. `plain` and `destructive` have no fill, for actions inside rows and cards. */
export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'regular',
  icon,
  loading,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useUnistyles();
  const tone = labelTone(variant);
  const color = toneColor(theme, tone);
  const filled = variant === 'primary' || variant === 'secondary';
  const iconSize = size === 'small' ? 14 : 17;
  return (
    <Touch
      feedback={filled ? 'card' : 'opacity'}
      onPress={onPress}
      disabled={disabled || loading}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: loading }}
      hitSlop={filled ? undefined : theme.space.md}
      style={[styles.button(variant, size), style]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color} />
      ) : icon ? (
        <Icon name={icon} size={iconSize} color={color} />
      ) : null}
      <Text variant={size === 'small' ? 'callout' : 'body'} weight="semibold" tone={tone} style={styles.label}>
        {title}
      </Text>
    </Touch>
  );
}

/** A round icon-only button for headers and toolbars. `media` is for the device viewer's dark chrome. */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  tone = 'secondary',
  size = 'regular',
  disabled,
}: {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  tone?: 'default' | 'secondary' | 'brand' | 'media';
  size?: 'regular' | 'large';
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  const color =
    tone === 'media'
      ? theme.media.text
      : tone === 'brand'
        ? theme.colors.primary
        : tone === 'default'
          ? theme.colors.text
          : theme.colors.secondary;
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityLabel={accessibilityLabel}
      hitSlop={theme.space.md}
      style={styles.iconButton}
    >
      <Icon name={icon} size={size === 'large' ? 22 : 20} color={color} />
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: (variant: ButtonVariant, size: ButtonSize) => {
    const filled = variant === 'primary' || variant === 'secondary';
    return {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.space.sm,
      borderRadius: size === 'small' ? theme.radius.control : theme.radius.card,
      borderCurve: 'continuous',
      backgroundColor:
        variant === 'primary' ? theme.colors.primary : variant === 'secondary' ? theme.colors.raised : undefined,
      paddingVertical: filled ? (size === 'small' ? theme.space.sm : theme.space.lg) : 0,
      paddingHorizontal: filled ? (size === 'small' ? theme.space.lg : theme.space.xxl) : 0,
    };
  },
  label: { flexShrink: 1 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.round,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
