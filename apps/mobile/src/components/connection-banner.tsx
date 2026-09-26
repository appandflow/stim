import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';

import type { ConnectionState } from '@/lib/connection';
import { useColors } from '@/theme';

export function ConnectionBanner({ state, style }: { state: ConnectionState; style?: { marginHorizontal: number } }) {
  const colors = useColors();
  if (state.kind === 'open') return null;
  const text =
    state.kind === 'connecting'
      ? 'Connecting'
      : state.kind === 'waiting'
        ? `${state.reason} Retrying in ${Math.round(state.retryInMs / 1000)}s.`
        : state.kind === 'refused'
          ? state.code === 'protocol-unsupported'
            ? `${state.reason} Update this app or the Stim server on the machine.`
            : `${state.reason} Pair this machine again from Stim Desktop.`
          : 'Disconnected';
  const connecting = state.kind === 'connecting';
  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOutUp.duration(200)}
      style={[styles.banner, { backgroundColor: connecting ? colors.raised : colors.error }, style]}
    >
      <Text style={[styles.text, { color: connecting ? colors.secondary : colors.background }]}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: 16, paddingVertical: 6 },
  text: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
});
