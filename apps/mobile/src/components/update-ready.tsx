import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useAppUpdate, useForegroundUpdateCheck } from '@/hooks/app-update';

/** Checks for updates on foreground and offers a tap to restart into a downloaded one. */
export function UpdateReady() {
  useForegroundUpdateCheck();
  const { ready } = useAppUpdate();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  if (!ready) return null;
  return (
    <Touch
      accessibilityRole="button"
      accessibilityLabel="Update ready, restart to apply"
      onPress={() => void Updates.reloadAsync()}
      style={[styles.pill, { bottom: insets.bottom + theme.space.xl }]}
    >
      <Text variant="footnote" weight="semibold" tone="brand">
        Update ready
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
    borderRadius: theme.radius.round,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.raised,
    borderColor: theme.colors.border,
    shadowColor: theme.colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
}));
