import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useReplayAt, type ReplayPlayhead } from '@/hooks/device-stream';
import { useAgentActions } from '@/hooks/workspace-logs';
import { actionsAt } from '@/lib/logs';
import { clockTime } from '@/lib/format';

const ROWS = 3;
const KEPT = 200;
const ROW_HEIGHT = 20;

/**
 * The device's last agent actions, newest first, over the dark viewer: in replay, the ones at or before the frame
 * `playhead` shows. A failed action is in the error tone. Always `ROWS` rows tall, so the screen above keeps its
 * size.
 */
export function AgentFeed({
  workspace,
  slot,
  deviceId,
  playhead,
  onOpen,
}: {
  workspace: string;
  slot: string;
  deviceId: string;
  /** The replay's playhead; null while live. */
  playhead: ReplayPlayhead | null;
  onOpen: () => void;
}) {
  const actions = useAgentActions(workspace, slot, deviceId, KEPT);
  const shownAt = useReplayAt(playhead);
  const at = playhead === null ? null : (shownAt ?? undefined);
  const shown = at === undefined ? [] : actionsAt(actions, at).slice(0, ROWS);
  const list = shown
    .map(({ record }) => {
      const { msg } = record;
      const time = clockTime(record.ts);
      return t`${msg}, ${time}`;
    })
    .join('; ');
  const label =
    at === undefined ? t`Agent actions, loading` : shown.length ? t`Agent actions: ${list}` : t`No agent action yet`;
  return (
    <Touch
      feedback="opacity"
      onPress={onOpen}
      accessibilityLabel={label}
      accessibilityHint={t`Shows every agent action on this device`}
      style={styles.root}
    >
      {shown.length ? (
        shown.map(({ key, record }) => {
          const failed = record.level === 'error';
          return (
            <View key={key} style={styles.row}>
              <Text variant="caption" maxFontSizeMultiplier={1.2} style={styles.age}>
                {clockTime(record.ts)}
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
          {at === null ? (
            <Trans>No agent action on this device yet.</Trans>
          ) : (
            <Trans>No agent action loaded before this moment.</Trans>
          )}
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
  age: { width: 76, color: theme.media.textTertiary, fontVariant: ['tabular-nums'] },
  command: { color: theme.colors.accent },
  message: { flex: 1, color: theme.media.textSecondary },
  failed: { color: theme.colors.error },
  empty: { color: theme.media.textTertiary, lineHeight: ROW_HEIGHT },
}));
