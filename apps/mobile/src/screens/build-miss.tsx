import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useStatus } from '@/hooks/mac-connection';
import type { BuildMissChange, Platform } from '@/protocol/types';
import { mono, useColors } from '@/theme';

const CHANGE_MARK: Record<BuildMissChange['change'], string> = { added: '+', removed: '\u2212', changed: '~' };

export function BuildMiss({ path, platform }: { path: string; platform: Platform }) {
  const colors = useColors();
  const status = useStatus();
  const report = status?.environments.find((e) => e.path === path)?.lastBuilds?.[platform];
  const reason = report?.missReason;
  const title = `Why ${platform === 'ios' ? 'iOS' : 'Android'} compiled`;
  if (!reason) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.note, { color: colors.secondary }]}>The last build no longer records a cache miss.</Text>
      </View>
    );
  }
  const hidden = reason.changeCount - reason.changes.length;
  const baseline = reason.baseline
    ? `Compared with ${reason.baseline.fingerprint.slice(0, 8)}, the last build ${
        reason.baseline.from === 'workspace' ? 'in this workspace' : 'of this project in another worktree'
      }.`
    : null;
  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.summary, { color: colors.text }]}>{reason.summary}</Text>
      {baseline ? <Text style={[styles.note, { color: colors.secondary }]}>{baseline}</Text> : null}
      {reason.changes.length ? (
        <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          {reason.changes.map((change) => (
            <View key={`${change.change}-${change.source}`} style={styles.change}>
              <Text
                style={[
                  styles.mark,
                  {
                    color:
                      change.change === 'added'
                        ? colors.live
                        : change.change === 'removed'
                          ? colors.error
                          : colors.warn,
                  },
                ]}
              >
                {CHANGE_MARK[change.change]}
              </Text>
              <Text style={[styles.source, { color: colors.text }]} numberOfLines={2}>
                {change.source}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {hidden > 0 ? (
        <Text style={[styles.note, { color: colors.tertiary }]}>
          {hidden === 1 ? '1 more source changed.' : `${hidden} more sources changed.`}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 28, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  summary: { fontSize: 16, fontWeight: '500' },
  note: { fontSize: 13, lineHeight: 18 },
  list: { borderWidth: 1, borderRadius: 12, borderCurve: 'continuous', paddingVertical: 6 },
  change: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  mark: { fontFamily: mono, fontSize: 14, width: 12, textAlign: 'center' },
  source: { fontFamily: mono, fontSize: 12, flex: 1 },
});
