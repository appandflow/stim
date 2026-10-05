import { t } from '@lingui/core/macro';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';

export function HostLabel({ host, color }: { host: string; color?: string }) {
  const { theme } = useUnistyles();
  const foreground = color ?? theme.colors.tertiary;
  return (
    <View style={styles.row}>
      <Icon name="desktopcomputer" size={11} color={foreground} />
      <Text variant="caption" style={[styles.text, { color: foreground }]} numberOfLines={1}>
        {t`on ${host}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs, flexShrink: 1 },
  text: { flexShrink: 1 },
}));
