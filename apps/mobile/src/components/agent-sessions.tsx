import * as Linking from 'expo-linking';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/components/agent-icon';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Text, type TextTone } from '@/components/text';
import { Touch } from '@/components/touch';
import type { FontWeight, TextVariant } from '@/design/tokens';
import { agentLabel, agentShortLabel, agentWebUrl, isEndedAgent, type AnyAgentSession } from '@/lib/agents';

/**
 * A workspace's most recent coding-agent session on one line: the tool's mark, the title, its age and how many others
 * work there. It is not an accessibility element; the row or card around it carries the spoken label.
 */
export function AgentSessionLine({
  agents,
  now,
  variant,
  weight,
  tone = 'default',
}: {
  agents: AnyAgentSession[];
  now: number;
  variant: TextVariant;
  weight?: FontWeight;
  tone?: TextTone;
}) {
  const { theme } = useUnistyles();
  const [agent, ...rest] = agents;
  if (!agent) return null;
  const short = agentShortLabel(agent, now);
  const age = isEndedAgent(agent) ? (short.age ? `ended ${short.age}` : 'ended') : short.age;
  const tail = [age, rest.length ? `+${rest.length}` : null].filter(Boolean).join(' \u00B7 ');
  return (
    <View style={styles.row}>
      <AgentIcon
        tool={agent.tool}
        size={theme.typography[variant].fontSize ?? 13}
        color={isEndedAgent(agent) ? theme.colors.tertiary : theme.colors.secondary}
      />
      <Text variant={variant} weight={weight} tone={tone} numberOfLines={1} style={styles.shrink}>
        {short.name}
      </Text>
      {tail ? (
        <Text variant={variant} tone="tertiary" style={styles.fixed}>
          {tail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One session in a list; a session with a web link opens it in the Claude app or on claude.ai. An ended session is
 * muted. With `card`, a session with a link is a card of its own, for a section that holds only this session.
 */
export function AgentSessionRow({ agent, now, card = false }: { agent: AnyAgentSession; now: number; card?: boolean }) {
  const { theme } = useUnistyles();
  const label = agentLabel(agent, now);
  const short = agentShortLabel(agent, now);
  const url = agentWebUrl(agent);
  const ended = isEndedAgent(agent);
  const iconColor = ended ? theme.colors.tertiary : url ? theme.colors.brand : theme.colors.secondary;
  const titleTone: TextTone = ended ? 'secondary' : url ? 'brand' : 'default';
  const subtitle = ended
    ? short.age
      ? `Ended ${short.age} ago`
      : 'Ended'
    : short.age
      ? `Active ${short.age} ago`
      : null;
  const content = (
    <>
      <AgentIcon tool={agent.tool} size={18} color={iconColor} />
      <View style={styles.titles}>
        <Text variant="callout" tone={titleTone} numberOfLines={2}>
          {short.name}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone={ended ? 'tertiary' : 'secondary'}>
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
