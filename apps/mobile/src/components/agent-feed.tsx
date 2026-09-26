import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { useLogs, useMacConnection, type LogsChange } from '@/hooks/mac-connection';
import { agentActions, agentFeedFilter, type AgentAction } from '@/lib/logs';

export function AgentFeed({ workspace, slot, deviceId }: { workspace: string; slot: string; deviceId: string }) {
  const router = useRouter();
  const macId = useMacConnection().mac?.id ?? '';
  const [actions, setActions] = useState<AgentAction[]>([]);
  const filter = useMemo(() => agentFeedFilter(workspace, slot), [workspace, slot]);
  const onChange = useCallback(
    (change: LogsChange) => {
      if (change.kind === 'reset') setActions([]);
      if (change.kind === 'records') setActions((existing) => agentActions(existing, change.records, deviceId));
    },
    [deviceId],
  );
  useLogs(filter, onChange);
  if (actions.length === 0) return null;
  const openLog = (at?: number) =>
    router.push({
      pathname: '/mac/[id]/logs',
      params: { id: macId, path: workspace, source: 'agent', slot, ...(at === undefined ? {} : { at: String(at) }) },
    });
  return (
    <View style={styles.feed}>
      <Touch
        onPress={() => openLog()}
        accessibilityLabel="Agent actions"
        accessibilityHint="Opens every agent action on this device"
        hitSlop={6}
        style={styles.header}
      >
        <Text variant="caption2" weight="semibold" tone="secondary">
          Agent actions
        </Text>
        <Text variant="caption2" weight="semibold" tone="brand">
          {'All \u203A'}
        </Text>
      </Touch>
      {actions.map(({ key, record }) => {
        const time = new Date(record.ts).toTimeString().slice(0, 8);
        return (
          <Touch
            key={key}
            feedback="row"
            onPress={() => openLog(record.ts)}
            accessibilityLabel={`${time}, ${record.msg}`}
            accessibilityHint="Opens this action in the agent log"
            style={styles.row}
          >
            <Text variant="caption2" tone="tertiary" mono>
              {time}
            </Text>
            <Text
              variant="caption2"
              tone={record.level === 'error' ? 'error' : 'default'}
              mono
              style={styles.msg}
              numberOfLines={1}
            >
              {record.msg}
            </Text>
          </Touch>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  feed: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    gap: theme.space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
  row: { flexDirection: 'row', gap: theme.space.md },
  msg: { flexShrink: 1 },
}));
