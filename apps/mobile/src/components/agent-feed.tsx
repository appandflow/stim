import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useNow } from '@/hooks/use-now';
import { useAgentActions } from '@/hooks/workspace-logs';
import { actionsAt } from '@/lib/logs';
import { sinceLabel } from '@/lib/workspace-view';

const ROWS = 3;
const KEPT = 200;
const ROW_HEIGHT = 20;

/**
 * The device's last agent actions, newest first, over the dark viewer: in replay, the ones at or before `at`. A
 * failed action is in the error tone. Always `ROWS` rows tall, so the screen above keeps its size.
 */
export function AgentFeed({
  workspace,
  slot,
  deviceId,
  at,
  onOpen,
}: {
  workspace: string;
  slot: string;
  deviceId: string;
  /** The replay playhead, a Mac capture time; null while live, undefined while a replay has no frame yet. */
  at: number | null | undefined;
  onOpen: () => void;
}) {
  const now = useNow(1000);
  const actions = useAgentActions(workspace, slot, deviceId, KEPT);
  const shown = at === undefined ? [] : actionsAt(actions, at).slice(0, ROWS);
  return (
    <Touch
      feedback="opacity"
      onPress={onOpen}
      accessibilityLabel={
        at === undefined
          ? 'Agent actions, loading'
          : shown.length
            ? `Agent actions: ${shown.map(({ record }) => `${record.msg}, ${sinceLabel(now - record.ts)} ago`).join('; ')}`
            : 'No agent action yet'
      }
      accessibilityHint="Shows every agent action on this device"
      style={styles.root}
    >
      {shown.length ? (
        shown.map(({ key, record }) => {
          const failed = record.level === 'error';
          return (
            <View key={key} style={styles.row}>
              <Text variant="caption" maxFontSizeMultiplier={1.2} style={styles.age}>
                {sinceLabel(now - record.ts)}
              </Text>
              {typeof record.command === 'string' ? (
                <Text
                  variant="caption"
                  weight="semibold"
                  maxFontSizeMultiplier={1.2}
                  style={failed ? styles.failed : styles.command}
                >
                  {record.command}
                </Text>
              ) : null}
              <Text
                variant="caption"
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}
                style={[styles.message, failed && styles.failed]}
              >
                {record.msg}
              </Text>
            </View>
          );
        })
      ) : at === undefined ? null : (
        <Text variant="caption" maxFontSizeMultiplier={1.2} style={styles.empty}>
          {at === null ? 'No agent action on this device yet.' : 'No agent action loaded before this moment.'}
        </Text>
      )}
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    height: ROWS * ROW_HEIGHT + theme.space.sm * 2,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.sm,
  },
  row: { height: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  age: { width: 32, color: theme.media.textTertiary, fontVariant: ['tabular-nums'] },
  command: { color: theme.colors.accent },
  message: { flex: 1, color: theme.media.textSecondary },
  failed: { color: theme.colors.error },
  empty: { color: theme.media.textTertiary, lineHeight: ROW_HEIGHT },
}));
