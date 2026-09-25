import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { Chip } from '@/components/chip';
import { useNow } from '@/hooks/use-now';
import { shortDuration } from '@/lib/format';
import type { RemoteDeviceState } from '@/protocol/types';
import { mono, useColors } from '@/theme';

export function RemoteTile({ session }: { session: RemoteDeviceState }) {
  const colors = useColors();
  const now = useNow(30_000);
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  return (
    <Card ring={colors.remote}>
      <View style={styles.body}>
        <View style={styles.row}>
          <Text style={[styles.title, { color: colors.text }]}>
            EAS Simulator{session.platform ? ` \u00B7 ${session.platform === 'ios' ? 'iOS' : 'Android'}` : ''}
          </Text>
          <View style={styles.spacer} />
          <Chip tint={colors.warn}>billable</Chip>
        </View>
        <Text style={[styles.detail, { color: colors.secondary }]} selectable>
          {session.sessionId}
        </Text>
        <Text style={[styles.meta, { color: colors.tertiary }]}>
          {session.state === 'claimed'
            ? 'Claimed by this workspace'
            : session.state === 'unclaimed'
              ? 'Not claimed'
              : 'Claim unknown'}
          {Number.isFinite(started) ? ` \u00B7 running ${shortDuration(now - started)}` : ''}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '600' },
  spacer: { flex: 1 },
  detail: { fontSize: 12, fontFamily: mono },
  meta: { fontSize: 12 },
});
