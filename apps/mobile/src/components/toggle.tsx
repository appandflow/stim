import type { ReactNode } from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';

export function Toggle({
  label,
  on,
  disabled,
  icon,
  count,
  countTone = 'secondary',
  onPress,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  count?: number;
  countTone?: TextTone;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      defaultOpacity={disabled ? theme.opacity.disabled : 1}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={count === undefined ? undefined : `${label}, ${count}`}
      hitSlop={{ top: 8, bottom: 8 }}
      style={styles.toggle(on)}
    >
      {icon}
      <Text variant="footnote" weight="medium" tone={on ? 'brand' : 'secondary'}>
        {label}
        {count === undefined ? null : (
          <Text variant="footnote" weight="semibold" tone={countTone} style={styles.count}>
            {` \u00B7 ${count}`}
          </Text>
        )}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: (on: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.xs,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    backgroundColor: on ? withAlpha(theme.colors.primary, theme.opacity.tint) : 'transparent',
    borderColor: on ? theme.colors.primary : theme.colors.border,
  }),
  count: { fontVariant: ['tabular-nums'] },
}));
