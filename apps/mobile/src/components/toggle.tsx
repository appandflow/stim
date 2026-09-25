import { Pressable, StyleSheet, Text } from 'react-native';

import { radius, type Colors } from '@/theme';

export function Toggle({
  colors,
  label,
  on,
  onPress,
}: {
  colors: Colors;
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      style={[
        styles.toggle,
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
});
