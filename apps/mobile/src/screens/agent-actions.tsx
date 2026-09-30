import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ListSection } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import { useMacConnection, useStatus } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { useAgentActions } from '@/hooks/workspace-logs';
import { formatDuration } from '@/intl/format';
import { clockTime } from '@/lib/format';
import { agentFilterOptions, matchesAgentFilter, type AgentFilter } from '@/lib/logs';
import { deviceTitle } from '@/lib/workspace-view';
import { devicesOf, platformName } from '@/lib/workspaces';
import type { DevicePlatform } from '@/protocol/types';

const MAX_ACTIONS = 200;

export function AgentActions({
  path,
  platform,
  slot,
  deviceId,
}: {
  path: string;
  platform: DevicePlatform;
  slot: string;
  deviceId: string;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const macId = useMacConnection().mac?.id ?? '';
  const status = useStatus();
  const now = useNow(5000);
  const env = status?.environments.find((e) => e.path === path);
  const device = env ? devicesOf(env).find((d) => d.platform === platform && d.slot === slot) : undefined;
  const actions = useAgentActions(path, slot, deviceId, MAX_ACTIONS);
  const [filter, setFilter] = useState<AgentFilter>({ kind: 'all' });
  const options = agentFilterOptions(actions);
  const shown = actions.filter((action) => matchesAgentFilter(action, filter));
  const activity = device?.activity;
  const driven = activity?.state === 'driven';
  const tool = driven ? (activity.driver?.tool ?? t`Agent`) : t`No agent`;
  const since = driven && activity.driver?.since ? Date.parse(activity.driver.since) : NaN;
  const name = device ? deviceTitle(device).name : platformName(platform);
  const driving = Number.isFinite(since) ? formatDuration(Math.max(0, now - since)) : null;
  const subtitle = [
    driving === null ? null : t`driving ${driving}`,
    plural(actions.length, { one: '# action', other: '# actions' }),
  ]
    .filter(Boolean)
    .join(' \u00B7 ');
  const titleText = t`${name} \u00B7 ${tool}`;
  const openLog = (at?: number) =>
    router.push({
      pathname: '/mac/[id]/logs',
      params: { id: macId, path, source: 'agent', slot, ...(at === undefined ? {} : { at: String(at) }) },
    });
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text variant="title" numberOfLines={1}>
            {titleText}
          </Text>
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        </View>
        {driven ? (
          <Pill tone="success">
            <Trans>active</Trans>
          </Pill>
        ) : null}
      </View>
      {actions.length ? (
        <View style={styles.filters}>
          {options.map((option) => {
            const selected = JSON.stringify(option.filter) === JSON.stringify(filter);
            const { label, count } = option;
            const filterText = t`${label} \u00B7 ${count}`;
            return (
              <Touch
                key={JSON.stringify(option.filter)}
                onPress={() => setFilter(option.filter)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.filter, selected && styles.filterSelected]}
              >
                <Text
                  variant="footnote"
                  weight="medium"
                  tone={selected ? 'brand' : option.filter.kind === 'failed' ? 'error' : 'default'}
                >
                  {filterText}
                </Text>
              </Touch>
            );
          })}
        </View>
      ) : null}
      {shown.length ? (
        <ListSection>
          {shown.map(({ key, record }, i) => {
            const failed = record.level === 'error';
            const time = clockTime(record.ts);
            const { msg } = record;
            return (
              <Touch
                key={key}
                feedback="row"
                onPress={() => openLog(record.ts)}
                accessibilityLabel={t`${time}, ${msg}`}
                accessibilityHint={t`Opens this action in the agent log`}
                style={[styles.action, i > 0 && styles.separated]}
              >
                <Text variant="caption" tone="tertiary" style={styles.time}>
                  {clockTime(record.ts)}
                </Text>
                {typeof record.command === 'string' ? (
                  <Text variant="callout" weight="semibold" tone={failed ? 'error' : 'brand'}>
                    {record.command}
                  </Text>
                ) : null}
                <Text variant="callout" tone={failed ? 'error' : 'default'} numberOfLines={1} style={styles.grow}>
                  {record.msg}
                </Text>
              </Touch>
            );
          })}
        </ListSection>
      ) : (
        <Text variant="footnote" tone="secondary">
          <Trans>No agent action on this device yet.</Trans>
        </Text>
      )}
      <Button title={t`Open in logs`} variant="secondary" onPress={() => openLog()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.xl, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.md },
  titles: { flex: 1, gap: theme.space.xxs },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  filter: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.round,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  filterSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: withAlpha(theme.colors.primary, theme.opacity.tint),
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md + 2,
  },
  separated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.separator },
  time: { width: 76, fontVariant: ['tabular-nums'] },
  grow: { flex: 1 },
}));
