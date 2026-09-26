import { useEffect } from 'react';
import { ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';

export interface Toast {
  kind: 'pending' | 'success' | 'error';
  message: string;
}

const DISMISS_MS = { success: 2500, error: 8000 };

export function ActionToast({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!toast || toast.kind === 'pending') return;
    const timer = setTimeout(onDismiss, DISMISS_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  if (!toast) return null;
  return (
    <Touch
      onPress={toast.kind === 'pending' ? undefined : onDismiss}
      {...(toast.kind === 'pending' ? { activeOpacity: 1 } : null)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.toast, { bottom: insets.bottom + theme.space.xl }]}
    >
      {toast.kind === 'pending' ? <ActivityIndicator size="small" color={theme.colors.secondary} /> : null}
      <Text
        variant="callout"
        weight="medium"
        tone={toast.kind === 'error' ? 'error' : toast.kind === 'success' ? 'success' : 'default'}
        style={styles.text}
      >
        {toast.message}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  toast: {
    position: 'absolute',
    left: theme.space.xl,
    right: theme.space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.raised,
    borderColor: theme.colors.border,
    shadowColor: theme.colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  text: { flex: 1 },
}));
