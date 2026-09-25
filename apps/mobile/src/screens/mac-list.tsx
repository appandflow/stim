import { Link, Stack, useRouter } from 'expo-router';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { StatusDot } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { connectionColor, describeState } from '@/components/mac-chip';
import { useMacs } from '@/hooks/mac-connection';
import { forgetMac, type PairedMac } from '@/lib/macs';
import { mono, radius, useColors } from '@/theme';

export function MacList() {
  const colors = useColors();
  const router = useRouter();
  const { macs, reload, connections } = useMacs();

  const forget = (mac: PairedMac) =>
    Alert.alert(`Forget ${mac.name}?`, 'This phone stops connecting to it. Pair again from Stim Desktop to undo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => forgetMac(mac.id).then(reload) },
    ]);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/pair')} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.headerButton, { color: colors.primary }]}>Pair</Text>
            </Pressable>
          ),
        }}
      />
      {macs && macs.length === 0 ? (
        <EmptyState
          title="No machine paired"
          message="In Stim Desktop, open Pair a phone and scan its QR code. This phone and the machine both need Tailscale."
        >
          <Pressable
            onPress={() => router.push('/pair')}
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            accessibilityRole="button"
          >
            <Text style={[styles.primaryButtonText, { color: colors.onPrimary }]}>Pair a machine</Text>
          </Pressable>
        </EmptyState>
      ) : (
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
      )}
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: { fontSize: 17, fontWeight: '600', paddingHorizontal: 4 },
  list: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  rowText: { flex: 1, gap: 4 },
  name: { fontSize: 17, fontWeight: '600' },
  state: { fontSize: 13 },
  endpoint: { fontSize: 12, fontFamily: mono },
  rowAction: { fontSize: 14, fontWeight: '500' },
  primaryButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.card, marginTop: 8 },
  primaryButtonText: { fontSize: 16, fontWeight: '600' },
});
