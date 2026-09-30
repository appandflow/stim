import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollView } from '@/components/lists';
import { describeState } from '@/components/mac-chip';
import { Text } from '@/components/text';
import { useMacs, type PairedConnection } from '@/hooks/mac-connection';
import { PROTOCOL_VERSION } from '@/protocol/types';

export function About() {
  const { theme } = useUnistyles();
  const { connections } = useMacs();
  const version = Constants.expoConfig?.version ?? '';
  const update = Updates.isEmbeddedLaunch || !Updates.updateId ? t`embedded` : Updates.updateId;
  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.background }}>
      <Text variant="title">
        <Trans>About</Trans>
      </Text>
      <View style={styles.group}>
        <Text variant="body" weight="medium">
          <Trans>
            Stim for phones {version} \u00B7 protocol {PROTOCOL_VERSION}
          </Trans>
        </Text>
        <Text variant="footnote" tone="secondary">
          <Trans>Update {update}</Trans>
        </Text>
        {connections.map((c) => (
          <Text key={c.mac.id} variant="footnote" tone="secondary">
            {connectionLine(c)}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function connectionLine({ mac: { name }, state, missing }: PairedConnection): string {
  if (state.kind !== 'open') return `${name}: ${describeState(state, missing)}`;
  const { stim, version } = state.server;
  return t`${name}: stim ${stim} \u00B7 server ${version}`;
}

const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.space.xxl, paddingTop: theme.space.huge, gap: theme.space.xl },
  group: {
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    borderWidth: 1,
    padding: theme.space.xl,
    gap: theme.space.sm,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
}));
