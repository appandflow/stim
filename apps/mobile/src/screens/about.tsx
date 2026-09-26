import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { describeState } from '@/components/mac-chip';
import { useMacs } from '@/hooks/mac-connection';
import { PROTOCOL_VERSION } from '@/protocol/types';
import { useColors } from '@/theme';

export function About() {
  const colors = useColors();
  const { connections } = useMacs();
  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: colors.background }}>
      <Text style={[styles.title, { color: colors.text }]}>About</Text>
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.line, { color: colors.text }]}>
          {`Stim for phones ${Constants.expoConfig?.version ?? ''} · protocol ${PROTOCOL_VERSION}`}
        </Text>
        <Text style={[styles.note, { color: colors.secondary }]}>
          {`Update ${Updates.isEmbeddedLaunch || !Updates.updateId ? 'embedded' : Updates.updateId}`}
        </Text>
        <Text style={[styles.note, { color: colors.secondary }]}>
          Read-only: this app watches workspaces, devices and logs on your machines and changes nothing.
        </Text>
        {connections.map((c) => (
          <Text key={c.mac.id} style={[styles.note, { color: colors.secondary }]}>
            {c.state.kind === 'open'
              ? `${c.mac.name}: stim ${c.state.server.stim} · server ${c.state.server.version}`
              : `${c.mac.name}: ${describeState(c.state, c.missing)}`}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 28, gap: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  group: { borderRadius: 14, borderCurve: 'continuous', borderWidth: 1, padding: 16, gap: 6 },
  line: { fontSize: 15, fontWeight: '500' },
  note: { fontSize: 13, lineHeight: 18 },
});
