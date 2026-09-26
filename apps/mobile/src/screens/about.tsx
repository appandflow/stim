import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollView } from '@/components/lists';
import { describeState } from '@/components/mac-chip';
import { Text } from '@/components/text';
import { useMacs } from '@/hooks/mac-connection';
import { PROTOCOL_VERSION } from '@/protocol/types';

export function About() {
  const { theme } = useUnistyles();
  const { connections } = useMacs();
  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.background }}>
      <Text variant="title">About</Text>
      <View style={styles.group}>
        <Text variant="body" weight="medium">
          {`Stim for phones ${Constants.expoConfig?.version ?? ''} \u00B7 protocol ${PROTOCOL_VERSION}`}
        </Text>
        <Text variant="footnote" tone="secondary">
          {`Update ${Updates.isEmbeddedLaunch || !Updates.updateId ? 'embedded' : Updates.updateId}`}
        </Text>
        <Text variant="footnote" tone="secondary">
          Read-only: this app watches workspaces, devices and logs on your machines and changes nothing.
        </Text>
        {connections.map((c) => (
          <Text key={c.mac.id} variant="footnote" tone="secondary">
            {c.state.kind === 'open'
              ? `${c.mac.name}: stim ${c.state.server.stim} \u00B7 server ${c.state.server.version}`
              : `${c.mac.name}: ${describeState(c.state, c.missing)}`}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
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
