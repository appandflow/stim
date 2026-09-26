import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Touch } from '@/components/touch';
import { useColors } from '@/theme';

export interface Toast {
  kind: 'pending' | 'success' | 'error';
  message: string;
}

const DISMISS_MS = { success: 2500, error: 8000 };

export function ActionToast({ toast, onDismiss }: { toast: Toast | null; onDismiss: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!toast || toast.kind === 'pending') return;
    const timer = setTimeout(onDismiss, DISMISS_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  if (!toast) return null;
  const tint = toast.kind === 'error' ? colors.error : toast.kind === 'success' ? colors.live : colors.text;
  return (
    <Touch
      onPress={toast.kind === 'pending' ? undefined : onDismiss}
      {...(toast.kind === 'pending' ? { activeOpacity: 1 } : null)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.toast, { bottom: insets.bottom + 16, backgroundColor: colors.raised, borderColor: colors.border }]}
    >
      {toast.kind === 'pending' ? <ActivityIndicator size="small" color={colors.secondary} /> : null}
      <Text style={[styles.text, { color: tint }]}>{toast.message}</Text>
    </Touch>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  text: { flex: 1, fontSize: 14, fontWeight: '500', lineHeight: 19 },
});
