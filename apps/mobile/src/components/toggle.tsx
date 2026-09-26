import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';

export function Toggle({
  label,
  on,
  disabled,
  onPress,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
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
      style={styles.toggle(on)}
    >
      <Text variant="footnote" weight="medium" tone={on ? 'brand' : 'secondary'}>
        {label}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: (on: boolean) => ({
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.xs,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    backgroundColor: on ? withAlpha(theme.colors.primary, theme.opacity.tint) : 'transparent',
    borderColor: on ? theme.colors.primary : theme.colors.border,
  }),
}));
