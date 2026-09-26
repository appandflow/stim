import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useLogs, useMacConnection, type LogsChange } from '@/hooks/mac-connection';
import { agentActions, agentFeedFilter, type AgentAction } from '@/lib/logs';
import { mono, useColors } from '@/theme';

export function AgentFeed({ workspace, slot, deviceId }: { workspace: string; slot: string; deviceId: string }) {
  const colors = useColors();
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
    <View style={[styles.feed, { borderTopColor: colors.border }]}>
      <Pressable
        onPress={() => openLog()}
        accessibilityRole="button"
        accessibilityLabel="Agent actions"
        accessibilityHint="Opens every agent action on this device"
        hitSlop={6}
        style={styles.header}
      >
        <Text style={[styles.title, { color: colors.secondary }]}>Agent actions</Text>
        <Text style={[styles.title, { color: colors.primary }]}>{'All ›'}</Text>
      </Pressable>
      {actions.map(({ key, record }) => (
        <Pressable
          key={key}
          onPress={() => openLog(record.ts)}
          accessibilityRole="button"
          accessibilityHint="Opens this action in the agent log"
          style={styles.row}
        >
          <Text style={[styles.time, { color: colors.tertiary }]}>
            {new Date(record.ts).toTimeString().slice(0, 8)}
          </Text>
          <Text
            style={[styles.msg, { color: record.level === 'error' ? colors.error : colors.text }]}
            numberOfLines={1}
          >
            {record.msg}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  feed: { paddingHorizontal: 12, paddingVertical: 10, gap: 4, borderTopWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { fontSize: 11, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 },
  time: { fontFamily: mono, fontSize: 11 },
  msg: { fontFamily: mono, fontSize: 11, flexShrink: 1 },
});
