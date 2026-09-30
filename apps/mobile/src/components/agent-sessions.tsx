import * as Linking from 'expo-linking';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/components/agent-icon';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import type { FontWeight, TextVariant } from '@/design/tokens';
import { agentLabel, agentName, agentWebUrl, toolName } from '@/lib/agents';
import type { AgentSession } from '@/protocol/types';

/**
 * A workspace's agent session on one line: the tool's mark, the title and how many other sessions it has. It is not an
 * accessibility element; the row or card around it carries the spoken label.
 */
export function AgentSessionLine({
  sessions,
  variant,
  weight,
  tone = 'default',
}: {
  sessions: AgentSession[];
  variant: TextVariant;
  weight?: FontWeight;
  tone?: TextTone;
}) {
  const { theme } = useUnistyles();
  const [agent, ...rest] = sessions;
  if (!agent) return null;
  return (
    <View style={styles.row}>
      <AgentIcon tool={agent.tool} size={theme.typography[variant].fontSize ?? 13} color={theme.colors.secondary} />
      <Text variant={variant} weight={weight} tone={tone} numberOfLines={1} style={styles.shrink}>
        {agentName(agent)}
      </Text>
      {rest.length ? (
        <Text variant={variant} tone="tertiary" style={styles.fixed}>
          {`+${rest.length}`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One session in a list, named by its title with the tool below it; a session with a web link opens it in the Claude
 * app or on claude.ai. With `card`, a session with a link is a card of its own, for a section that holds only this
 * session.
 */
export function AgentSessionRow({ agent, card = false }: { agent: AgentSession; card?: boolean }) {
  const { theme } = useUnistyles();
  const label = agentLabel(agent);
  const url = agentWebUrl(agent);
  const subtitle = agent.title ? toolName(agent.tool) : null;
  const content = (
    <>
      <AgentIcon tool={agent.tool} size={18} color={url ? theme.colors.brand : theme.colors.secondary} />
      <View style={styles.titles}>
        <Text variant="callout" tone={url ? 'brand' : 'default'} numberOfLines={2}>
          {agentName(agent)}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {url ? <Icon name="chevron.right" size={13} color={theme.colors.tertiary} /> : null}
    </>
  );
  if (!url) {
    return (
      <View style={styles.listRow} accessible accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  const open = () => void Linking.openURL(url);
  const hint = 'Opens the session in the Claude app or on claude.ai';
  if (card) {
    return (
      <Card
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={styles.cardRow}
      >
        {content}
      </Card>
    );
  }
  return (
    <Touch
      feedback="row"
      onPress={open}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={styles.listRow}
    >
      {content}
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.xs + 1, rowGap: 2 },
  shrink: { flexShrink: 1 },
  fixed: { flexShrink: 0 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
  },
  titles: { flex: 1, gap: theme.space.xxs },
}));
