import { useRouter } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { StatusDot } from '@/components/chip';
import { FlatList } from '@/components/lists';
import { connectionColor, describeState } from '@/components/mac-chip';
import { ScopeChip } from '@/components/read-only';
import { Touch } from '@/components/touch';
import { useMacs } from '@/hooks/mac-connection';
import { forgetMac, type PairedMac } from '@/lib/macs';
import { mono, useColors } from '@/theme';

export function MacList() {
  const colors = useColors();
  const router = useRouter();
  const { reload, connections } = useMacs();

  const forget = (mac: PairedMac) =>
    Alert.alert(`Forget ${mac.name}?`, 'This phone stops connecting to it. Pair again from Stim Desktop to undo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => forgetMac(mac.id).then(reload) },
    ]);

  return (
    <FlatList
      data={connections}
      keyExtractor={({ mac }) => mac.id}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      renderItem={({ item: { mac: item, state, missing } }) => (
        <Card accessibilityRole="link" onPress={() => router.push({ pathname: '/mac/[id]', params: { id: item.id } })}>
          <View style={styles.row}>
            <StatusDot color={connectionColor(state, missing, colors)} />
            <View style={styles.rowText}>
              <View style={styles.nameRow}>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <ScopeChip state={state} />
              </View>
              <Text style={[styles.state, { color: colors.secondary }]} numberOfLines={1}>
                {describeState(state, missing)}
              </Text>
              <Text style={[styles.endpoint, { color: colors.secondary }]} numberOfLines={1}>
                {item.endpoint}
              </Text>
            </View>
            <Touch
              onPress={() => router.push({ pathname: '/rename', params: { id: item.id } })}
              hitSlop={8}
              accessibilityLabel={`Rename ${item.name}`}
            >
              <Text style={[styles.rowAction, { color: colors.primary }]}>Rename</Text>
            </Touch>
            <Touch onPress={() => forget(item)} hitSlop={8} accessibilityLabel={`Forget ${item.name}`}>
              <Text style={[styles.rowAction, { color: colors.error }]}>Forget</Text>
            </Touch>
          </View>
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  rowText: { flex: 1, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  state: { fontSize: 13 },
  endpoint: { fontSize: 12, fontFamily: mono },
  rowAction: { fontSize: 14, fontWeight: '500' },
});
