import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';
import { agentLabel } from '@/lib/agents';
import type { AgentSession } from '@/protocol/types';

/** The coding-agent sessions working in a workspace, one line each. */
export function AgentSessions({ agents, now }: { agents: AgentSession[] | undefined; now: number }) {
  if (!agents?.length) return null;
  return (
    <View style={styles.list}>
      {agents.map((agent) => (
        <Text key={`${agent.tool}:${agent.sessionId}`} variant="footnote" tone="secondary" numberOfLines={1}>
          {agentLabel(agent, now)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.space.xxs, marginTop: -theme.space.sm },
}));
