import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { useNow } from '@/hooks/use-now';
import { shortDuration } from '@/lib/format';
import type { RemoteDeviceState } from '@/protocol/types';

export function RemoteTile({ session }: { session: RemoteDeviceState }) {
  const { theme } = useUnistyles();
  const now = useNow(30_000);
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  return (
    <Card ring={theme.colors.info}>
      <View style={styles.body}>
        <View style={styles.row}>
          <Text variant="callout" weight="semibold">
            EAS Simulator{session.platform ? ` \u00B7 ${session.platform === 'ios' ? 'iOS' : 'Android'}` : ''}
          </Text>
          <View style={styles.spacer} />
          <Pill tone="warning">billable</Pill>
        </View>
        <Text variant="caption" tone="secondary" mono selectable>
          {session.sessionId}
        </Text>
        <Text variant="caption" tone="tertiary">
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

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.space.lg, gap: theme.space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  spacer: { flex: 1 },
}));
