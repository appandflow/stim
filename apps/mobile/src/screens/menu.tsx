import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { useRouter, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { describeState } from '@/components/mac-chip';
import { useMacs } from '@/hooks/mac-connection';
import { PROTOCOL_VERSION } from '@/protocol/types';
import { useColors } from '@/theme';

const WORDMARK = require('@/assets/images/wordmark.png');

export function Menu({ onClose }: { onClose: () => void }) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connections } = useMacs();
  const go = (href: Href) => {
    onClose();
    router.push(href);
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 20 }]}
      style={{ backgroundColor: colors.background }}
    >
      <Image
        source={WORDMARK}
        tintColor={colors.primary}
        style={styles.wordmark}
        contentFit="contain"
        accessibilityLabel="Stim"
      />
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Row
          icon="laptopcomputer"
          title="Machines"
          detail="Rename, forget, and see each machine's status"
          onPress={() => go('/macs')}
        />
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        <Row
          icon="plus"
          title="Pair a machine"
          detail="Scan the QR code Stim Desktop shows"
          onPress={() => go('/pair')}
        />
      </View>
      <Text style={[styles.groupTitle, { color: colors.tertiary }]}>About</Text>
      <View style={[styles.group, styles.about, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.aboutLine, { color: colors.text }]}>
          {`Stim for phones ${Constants.expoConfig?.version ?? ''} \u00B7 protocol ${PROTOCOL_VERSION}`}
        </Text>
        <Text style={[styles.aboutNote, { color: colors.secondary }]}>
          Read-only: this app watches workspaces, devices and logs on your machines and changes nothing.
        </Text>
        {connections.map((c) => (
          <Text key={c.mac.id} style={[styles.aboutNote, { color: colors.secondary }]}>
            {c.state.kind === 'open'
              ? `${c.mac.name}: stim ${c.state.server.stim} \u00B7 server ${c.state.server.version}`
              : `${c.mac.name}: ${describeState(c.state, c.missing)}`}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function Row({ icon, title, detail, onPress }: { icon: IconName; title: string; detail: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={detail}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.raised }]}
    >
      <Icon name={icon} size={20} color={colors.primary} />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowDetail, { color: colors.secondary }]}>{detail}</Text>
      </View>
      <Icon name="chevron.right" size={14} color={colors.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 12 },
  wordmark: { width: 59, height: 28, marginBottom: 12 },
  group: { borderRadius: 14, borderCurve: 'continuous', borderWidth: 1, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 13 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  rowDetail: { fontSize: 13 },
  groupTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 8 },
  about: { padding: 16, gap: 6 },
  aboutLine: { fontSize: 15, fontWeight: '500' },
  aboutNote: { fontSize: 13, lineHeight: 18 },
});
