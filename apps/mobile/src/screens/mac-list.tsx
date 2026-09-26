import { Link } from 'expo-router';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { StatusDot } from '@/components/chip';
import { connectionColor, describeState } from '@/components/mac-chip';
import { useMacs } from '@/hooks/mac-connection';
import { forgetMac, type PairedMac } from '@/lib/macs';
import { mono, useColors } from '@/theme';

export function MacList() {
  const colors = useColors();
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
        <Link href={{ pathname: '/mac/[id]', params: { id: item.id } }} asChild>
          <Pressable accessibilityRole="button">
            <Card>
              <View style={styles.row}>
                <StatusDot color={connectionColor(state, missing, colors)} />
                <View style={styles.rowText}>
                  <Text style={[styles.name, { color: colors.text }]}>{item.name}</Text>
                  <Text style={[styles.state, { color: colors.secondary }]} numberOfLines={1}>
                    {describeState(state, missing)}
                  </Text>
                  <Text style={[styles.endpoint, { color: colors.secondary }]} numberOfLines={1}>
                    {item.endpoint}
                  </Text>
                </View>
                <Link href={{ pathname: '/rename', params: { id: item.id } }} asChild>
                  <Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel={`Rename ${item.name}`}>
                    <Text style={[styles.rowAction, { color: colors.primary }]}>Rename</Text>
                  </Pressable>
                </Link>
                <Pressable
                  onPress={() => forget(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${item.name}`}
                >
                  <Text style={[styles.rowAction, { color: colors.error }]}>Forget</Text>
                </Pressable>
              </View>
            </Card>
          </Pressable>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  rowText: { flex: 1, gap: 4 },
  name: { fontSize: 17, fontWeight: '600' },
  state: { fontSize: 13 },
  endpoint: { fontSize: 12, fontFamily: mono },
  rowAction: { fontSize: 14, fontWeight: '500' },
});
