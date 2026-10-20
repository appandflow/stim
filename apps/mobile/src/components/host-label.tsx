import { t } from '@lingui/core/macro';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';

export function HostLabel({
  host,
  color,
  mode = 'running',
  variant = 'caption',
}: {
  host: string;
  color?: string;
  mode?: 'running' | 'building' | 'placed';
  variant?: 'caption' | 'footnote';
}) {
  const { theme } = useUnistyles();
  const foreground = color ?? theme.colors.tertiary;
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={
        mode === 'building' ? t`Building on ${host}` : mode === 'placed' ? t`On ${host}` : t`Running on ${host}`
      }
    >
      <Icon name="desktopcomputer" size={variant === 'footnote' ? 12 : 11} color={foreground} />
      <Text variant={variant} style={[styles.text, { color: foreground }]} numberOfLines={1}>
        {host}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, flexShrink: 1 },
  text: { flexShrink: 1 },
}));
