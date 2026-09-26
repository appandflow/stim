import type { ReactNode } from 'react';
import { Text as NativeText, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info';

function toneColor(theme: Theme, tone: PillTone): string {
  switch (tone) {
    case 'neutral':
      return theme.colors.secondary;
    case 'accent':
      return theme.colors.primary;
    default:
      return theme.colors[tone];
  }
}

function textTone(tone: PillTone): TextTone {
  return tone === 'neutral' ? 'secondary' : tone === 'accent' ? 'brand' : tone;
}

/**
 * A short status label on a tinted background. `tabular` is appended with tabular figures, for ports and counts that
 * update in place.
 */
export function Pill({
  tone = 'neutral',
  tabular,
  dot,
  icon,
  onPress,
  accessibilityLabel,
  children,
}: {
  tone?: PillTone;
  tabular?: string;
  dot?: boolean;
  icon?: IconName;
  onPress?: () => void;
  accessibilityLabel?: string;
  children?: ReactNode;
}) {
  const { theme } = useUnistyles();
  const color = toneColor(theme, tone);
  const content = (
    <>
      {dot ? <StatusDot color={color} /> : null}
      {icon ? <Icon name={icon} size={12} color={color} /> : null}
      <Text variant="caption" weight="medium" tone={textTone(tone)} style={styles.label} numberOfLines={1}>
        {children}
        {tabular ? <NativeText style={styles.tabular}>{tabular}</NativeText> : null}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Touch
        feedback="card"
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        hitSlop={6}
        style={styles.pill(tone)}
      >
        {content}
      </Touch>
    );
  }
  return (
    <View
      style={styles.pill(tone)}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {content}
    </View>
  );
}

export function StatusDot({ color, filled = true }: { color: string; filled?: boolean }) {
  return <View style={[styles.dot, { borderColor: color, backgroundColor: filled ? color : 'transparent' }]} />;
}

const styles = StyleSheet.create((theme) => ({
  pill: (tone: PillTone) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.xs,
    borderRadius: theme.radius.chip,
    borderCurve: 'continuous',
    maxWidth: '100%',
    backgroundColor: tone === 'neutral' ? theme.colors.raised : withAlpha(toneColor(theme, tone), theme.opacity.tint),
  }),
  label: { flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: theme.radius.round, borderWidth: 1 },
}));
