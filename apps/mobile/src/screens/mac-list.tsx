import { useRouter } from 'expo-router';
import { Alert, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { FlatList } from '@/components/lists';
import { connectionColor, describeState } from '@/components/mac-chip';
import { StatusDot } from '@/components/pill';
import { ScopeChip } from '@/components/read-only';
import { Text } from '@/components/text';
import { useMacs } from '@/hooks/mac-connection';
import { unregisterPush } from '@/hooks/notifications';
import { forgetMac, type PairedMac } from '@/lib/macs';

export function MacList() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { reload, connections } = useMacs();

  const forget = (mac: PairedMac) =>
    Alert.alert(`Forget ${mac.name}?`, 'This phone stops connecting to it. Pair again from Stim Desktop to undo.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => {
          unregisterPush(connections.find((c) => c.mac.id === mac.id)?.connection ?? null, mac.id);
          void forgetMac(mac.id).then(reload);
        },
      },
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
            <StatusDot color={connectionColor(state, missing, theme.colors)} />
            <View style={styles.rowText}>
              <View style={styles.nameRow}>
                <Text variant="headline" style={styles.shrink} numberOfLines={1}>
                  {item.name}
                </Text>
                <ScopeChip state={state} />
              </View>
              <Text variant="footnote" tone="secondary" numberOfLines={1}>
                {describeState(state, missing)}
              </Text>
              <Text variant="caption" tone="secondary" mono numberOfLines={1}>
                {item.endpoint}
              </Text>
            </View>
            <Button
              title="Rename"
              variant="plain"
              size="small"
              accessibilityLabel={`Rename ${item.name}`}
              onPress={() => router.push({ pathname: '/rename', params: { id: item.id } })}
            />
            <Button
              title="Forget"
              variant="destructive"
              size="small"
              accessibilityLabel={`Forget ${item.name}`}
              onPress={() => forget(item)}
            />
          </View>
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { padding: theme.space.xl, gap: theme.space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg, padding: theme.space.lg },
  rowText: { flex: 1, gap: theme.space.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  shrink: { flexShrink: 1 },
}));
