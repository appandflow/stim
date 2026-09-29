import * as Linking from 'expo-linking';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { agentLabel, agentWebUrl } from '@/lib/agents';
import type { AgentSession } from '@/protocol/types';

/** The coding-agent sessions working in a workspace, one line each; a session with a web link opens it. */
export function AgentSessions({ agents, now }: { agents: AgentSession[] | undefined; now: number }) {
  const { theme } = useUnistyles();
  if (!agents?.length) return null;
  return (
    <View style={styles.list}>
      {agents.map((agent) => {
        const key = `${agent.tool}:${agent.sessionId}`;
        const label = agentLabel(agent, now);
        const url = agentWebUrl(agent);
        if (!url) {
          return (
            <Text key={key} variant="footnote" tone="secondary" numberOfLines={1}>
              {label}
            </Text>
          );
        }
        return (
          <Touch
            key={key}
            onPress={() => void Linking.openURL(url)}
            accessibilityRole="link"
            accessibilityLabel={label}
            accessibilityHint="Opens the session in the Claude app or on claude.ai"
            hitSlop={6}
            style={styles.link}
          >
            <Text variant="footnote" tone="brand" numberOfLines={1} style={styles.shrink}>
              {label}
            </Text>
            <Icon name="chevron.right" size={12} color={theme.colors.brand} />
          </Touch>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.space.xxs, marginTop: -theme.space.sm },
  link: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xxs, alignSelf: 'flex-start', maxWidth: '100%' },
  shrink: { flexShrink: 1 },
}));
