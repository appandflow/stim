import { StyleSheet, Text, View } from 'react-native';

import type { ConnectionState } from '@/lib/connection';
import { useColors } from '@/theme';

export function ConnectionBanner({ state }: { state: ConnectionState }) {
  const colors = useColors();
  if (state.kind === 'open') return null;
  const text =
    state.kind === 'connecting'
      ? 'Connecting'
      : state.kind === 'waiting'
        ? `${state.reason} Retrying in ${Math.round(state.retryInMs / 1000)}s.`
        : state.kind === 'refused'
          ? `${state.reason} Forget this Mac and pair it again from Stim Desktop.`
          : 'Disconnected';
  const tint = state.kind === 'refused' ? colors.error : state.kind === 'connecting' ? colors.secondary : colors.warn;
  return (
    <View style={[styles.banner, { backgroundColor: `${tint}22` }]}>
      <Text style={[styles.text, { color: tint }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, marginHorizontal: 16, marginTop: 8 },
  text: { fontSize: 13, fontWeight: '500' },
});
