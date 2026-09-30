import { t } from '@lingui/core/macro';
import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Collapsible, DisclosureChevron } from '@/components/collapsible';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useSectionState } from '@/hooks/section-state';
import { sectionRows } from '@/lib/sections';

/**
 * A Machine section whose header folds it, with the first rows shown and a "Show all N" control, as on Stim
 * Desktop's Machine page. Both states are remembered per `id`. `rows` empty shows `empty` instead of the card.
 */
export function CollapsibleSection<T>({
  id,
  title,
  rows,
  rowKey,
  renderRow,
  trailing,
  note,
  empty,
  footer,
}: {
  id: string;
  title: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  trailing?: ReactNode;
  note?: ReactNode;
  empty?: string;
  footer?: ReactNode;
}) {
  const [state, update] = useSectionState(id);
  const { shown, toggle } = sectionRows(rows, state.showAll);
  const open = !state.collapsed;
  const count = rows.length;
  return (
    <View style={styles.section}>
      <Touch
        feedback="opacity"
        onPress={() => update({ collapsed: open })}
        accessibilityLabel={`${title}, ${rows.length}`}
        accessibilityHint={open ? t`Collapses the section` : t`Expands the section`}
        accessibilityState={{ expanded: open }}
        style={styles.header}
      >
        <DisclosureChevron open={open} size={12} />
        <Text variant="headline" numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text variant="callout" tone="tertiary" style={styles.count}>
          {rows.length}
        </Text>
        <View style={styles.trailing}>{trailing}</View>
      </Touch>
      <Collapsible open={open}>
        <View style={styles.body}>
          {note}
          {rows.length === 0 ? (
            empty ? (
              <Text variant="footnote" tone="tertiary" style={styles.empty}>
                {empty}
              </Text>
            ) : null
          ) : (
            <View style={styles.card}>
              {shown.map((row, index) => (
                <Fragment key={rowKey(row)}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  {renderRow(row)}
                </Fragment>
              ))}
              {toggle ? (
                <>
                  <View style={styles.separator} />
                  <Touch
                    feedback="row"
                    onPress={() => update({ showAll: !state.showAll })}
                    accessibilityLabel={state.showAll ? t`Show the first 10 ${title}` : t`Show all ${count} ${title}`}
                    style={styles.toggle}
                  >
                    <Text variant="callout" weight="medium" tone="brand">
                      {toggle}
                    </Text>
                  </Touch>
                </>
              ) : null}
            </View>
          )}
          {footer}
        </View>
      </Collapsible>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, paddingVertical: theme.space.xs },
  body: { gap: theme.space.sm },
  title: { flexShrink: 1 },
  count: { fontVariant: ['tabular-nums'] },
  trailing: { flex: 1, alignItems: 'flex-end' },
  empty: { paddingHorizontal: theme.space.xs },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.separator },
  toggle: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md },
}));
