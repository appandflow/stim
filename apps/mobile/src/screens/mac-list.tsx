import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
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
import { Touch } from '@/components/touch';
import { useMacs } from '@/hooks/machines';
import { useLargeText } from '@/hooks/large-text';
import { forgetInbox } from '@/hooks/inbox';
import { unregisterPush } from '@/hooks/notifications';
import { machineRecord, removeNotice } from '@/lib/machine-record';
import { forgetMac, type PairedMac } from '@/lib/macs';

export function MacList() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { reload, connections } = useMacs();
  const large = useLargeText();

  const remove = (mac: PairedMac) => {
    const { name } = mac;
    const link = connections.find((c) => c.mac.id === mac.id);
    const notice = removeNotice(link?.state ?? { kind: 'closed' });
    Alert.alert(t`Remove ${name}?`, t`This phone stops connecting to it. ${notice}`, [
      { text: t`Cancel`, style: 'cancel' },
      {
        text: t`Remove`,
        style: 'destructive',
        onPress: () => {
          unregisterPush(link?.connection ?? null, mac.id);
          forgetInbox(mac.id);
          void forgetMac(mac.id).then(reload);
        },
      },
    ]);
  };

  return (
    <FlatList
      data={connections}
      keyExtractor={({ mac }) => mac.id}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      renderItem={({ item: { mac: item, state, missing } }) => {
        const { name } = item;
        const { serverName, deviceName: record, deviceId: recordId } = machineRecord(state, name);
        return (
          <Card>
            <View style={large ? styles.rowStacked : styles.row}>
              <Touch
                feedback="row"
                accessibilityRole="link"
                onPress={() => router.push({ pathname: '/mac/[id]', params: { id: item.id } })}
                style={styles.open}
              >
                <StatusDot color={connectionColor(state, missing, theme.colors)} />
                <View style={styles.rowText}>
                  <View style={[styles.nameRow, large && styles.nameRowStacked]}>
                    <Text variant="headline" style={styles.shrink} numberOfLines={large ? 3 : 1}>
                      {item.name}
                    </Text>
                    <ScopeChip state={state} />
                  </View>
                  <Text variant="footnote" tone="secondary" numberOfLines={1}>
                    {describeState(state, missing)}
                  </Text>
                  {serverName ? (
                    <Text variant="footnote" tone="secondary" numberOfLines={large ? 3 : 1}>
                      <Trans>Named {serverName} on the machine</Trans>
                    </Text>
                  ) : null}
                  {record ? (
                    <Text variant="footnote" tone="secondary" numberOfLines={large ? 4 : 2}>
                      {recordId ? (
                        <Trans>
                          Listed there as {record}, id {recordId}
                        </Trans>
                      ) : (
                        <Trans>Listed there as {record}</Trans>
                      )}
                    </Text>
                  ) : null}
                  <Text variant="caption" tone="secondary" mono numberOfLines={large ? 3 : 1}>
                    {item.endpoint}
                  </Text>
                </View>
              </Touch>
              <View style={large ? styles.buttonsStacked : styles.buttons}>
                <Button
                  title={t`Rename`}
                  variant="plain"
                  size="small"
                  accessibilityLabel={t`Rename ${name} on this phone`}
                  onPress={() => router.push({ pathname: '/rename', params: { id: item.id } })}
                />
                <Button
                  title={t`Remove`}
                  variant="destructive"
                  size="small"
                  accessibilityLabel={t`Remove ${name}`}
                  onPress={() => remove(item)}
                />
              </View>
            </View>
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { padding: theme.space.xl, gap: theme.space.lg },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowStacked: { gap: theme.space.sm },
  open: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.lg, padding: theme.space.lg },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg, paddingRight: theme.space.lg },
  buttonsStacked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.lg,
  },
  rowText: { flex: 1, gap: theme.space.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  nameRowStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: theme.space.xs },
  shrink: { flexShrink: 1 },
}));
