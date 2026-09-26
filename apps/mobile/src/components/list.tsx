import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';

/** A section's uppercase title, with an optional action at the trailing edge. */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.header}>
      <Text variant="footnote" weight="semibold" tone="tertiary" style={styles.title}>
        {title}
      </Text>
      {action}
    </View>
  );
}

/** A titled group of rows on one rounded surface, with an optional header action and footer. */
export function ListSection({
  title,
  action,
  footer,
  children,
}: {
  title?: string;
  action?: ReactNode;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      {title ? <SectionHeader title={title} action={action} /> : null}
      <View style={styles.card}>{children}</View>
      {footer ? (
        <Text variant="footnote" tone="secondary" style={styles.footer}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One row in a `ListSection`. `value` sits at the trailing edge; `accessory` follows it, or `'chevron'` for a row
 * that opens another screen.
 */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  value,
  valueTone = 'default',
  accessory,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  value?: string;
  valueTone?: TextTone;
  accessory?: ReactNode | 'chevron';
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  const content = (
    <>
      {icon ? <Icon name={icon} size={20} color={iconColor ?? theme.colors.primary} /> : null}
      <View style={styles.titles}>
        <Text variant="callout" tone={value ? 'secondary' : 'default'} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="callout" weight="medium" tone={valueTone} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {accessory === 'chevron' ? (
        <Icon name="chevron.right" size={13} color={theme.colors.tertiary} />
      ) : (
        (accessory ?? null)
      )}
    </>
  );
  if (onPress) {
    return (
      <Touch feedback="row" onPress={onPress} accessibilityLabel={accessibilityLabel} style={styles.row}>
        {content}
      </Touch>
    );
  }
  return <View style={styles.row}>{content}</View>;
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.space.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.lg },
  title: { textTransform: 'uppercase', letterSpacing: 0.4 },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    paddingVertical: theme.space.sm,
    overflow: 'hidden',
  },
  footer: { paddingHorizontal: theme.space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  titles: { flex: 1, gap: theme.space.xxs },
  value: { fontVariant: ['tabular-nums'], textAlign: 'right' },
}));
