import { Pressable, StyleSheet, Text } from 'react-native';

import { radius, type Colors } from '@/theme';

export function Toggle({
  colors,
  label,
  on,
  disabled,
  onPress,
}: {
  colors: Colors;
  label: string;
  on: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      style={[
        styles.toggle,
        disabled && styles.disabled,
        {
          backgroundColor: on ? `${colors.primary}29` : 'transparent',
          borderColor: on ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={[styles.toggleText, { color: on ? colors.primary : colors.secondary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: radius.chip, borderWidth: 1 },
  toggleText: { fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.4 },
});
