import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLogs, type LogsChange } from '@/hooks/mac-connection';
import { agentActions, agentFeedFilter, type AgentAction } from '@/lib/logs';
import { mono, useColors } from '@/theme';

export function AgentFeed({ workspace, slot, deviceId }: { workspace: string; slot: string; deviceId: string }) {
  const colors = useColors();
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
  return (
    <View style={[styles.feed, { borderTopColor: colors.border }]} accessibilityLabel="Agent actions">
      <Text style={[styles.title, { color: colors.secondary }]}>Agent actions</Text>
      {actions.map(({ key, record }) => (
        <View key={key} style={styles.row}>
          <Text style={[styles.time, { color: colors.tertiary }]}>
            {new Date(record.ts).toTimeString().slice(0, 8)}
          </Text>
          <Text
            style={[styles.msg, { color: record.level === 'error' ? colors.error : colors.text }]}
            numberOfLines={1}
          >
            {record.msg}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  feed: { paddingHorizontal: 12, paddingVertical: 10, gap: 4, borderTopWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 11, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 },
  time: { fontFamily: mono, fontSize: 11 },
  msg: { fontFamily: mono, fontSize: 11, flexShrink: 1 },
});
