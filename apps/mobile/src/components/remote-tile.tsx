import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { useNow } from '@/hooks/use-now';
import { formatDuration } from '@/intl/format';
import { platformName } from '@/lib/workspaces';
import type { RemoteDeviceState } from '@/protocol/types';

export function RemoteTile({ session }: { session: RemoteDeviceState }) {
  const now = useNow(30_000);
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const platform =
    session.backend === 'eas' && (session.platform === 'ios' || session.platform === 'android')
      ? session.platform
      : null;
  const platformLabel = platform ? platformName(platform) : '';
  const title = platform ? t`EAS Simulator \u00B7 ${platformLabel}` : t`EAS Simulator`;
  const claim =
    session.state === 'claimed'
      ? t`Claimed by this workspace`
      : session.state === 'unclaimed'
        ? t`Not claimed`
        : t`Claim unknown`;
  const running = formatDuration(now - started);
  const runningText = Number.isFinite(started) ? t` \u00B7 running ${running}` : '';
  return (
    <Card>
      <View style={styles.body}>
        <View style={styles.row}>
          <Text variant="callout" weight="semibold">
            {title}
          </Text>
          <View style={styles.spacer} />
          <Pill tone="warning">
            <Trans>billable</Trans>
          </Pill>
        </View>
        <Text variant="caption" tone="secondary" mono selectable>
          {session.sessionId}
        </Text>
        <Text variant="caption" tone="tertiary">
          {claim}
          {runningText}
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
