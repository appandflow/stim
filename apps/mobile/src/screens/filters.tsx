import { Host } from '@expo/ui';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { SectionHeader } from '@/components/list';
import { SheetScreen } from '@/components/sheet-screen';
import { Switch } from '@/components/switch';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/machines';
import { hapticFeedback } from '@/lib/haptics';
import { mergeWorkspaces, projectNames, type ActivityFilter } from '@/lib/home';

const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export function Filters() {
  const { theme } = useUnistyles();
  const { connections } = useMacs();
  const { filters, update, reset } = useHomeFilters();
  const projects = useMemo(
    () => projectNames(mergeWorkspaces(connections.map((c) => ({ id: c.mac.id, name: c.mac.name, status: c.status })))),
    [connections],
  );
  const activity: { value: ActivityFilter; label: string }[] = [
    { value: 'live', label: t`Live` },
    { value: 'idle', label: t`Idle` },
    { value: 'all', label: t`All` },
  ];
  const selectedMacs = filters.macs.filter((id) => connections.some((c) => c.mac.id === id));

  return (
    <SheetScreen title={t`Filters`} gap="xxl" accessory={<Button title={t`Reset`} variant="plain" onPress={reset} />}>
      <Group title={t`Show`}>
        {activity.map(({ value, label }) => (
          <Toggle
            key={value}
            label={label}
            on={filters.activity === value}
            onPress={() => {
              if (filters.activity !== value) hapticFeedback('selection');
              update({ activity: value });
            }}
          />
        ))}
      </Group>
      {connections.length > 1 ? (
        <Group title={t`Machines`}>
          <Toggle
            label={t`All`}
            on={selectedMacs.length === 0}
            onPress={() => {
              if (selectedMacs.length > 0) hapticFeedback('selection');
              update({ macs: [] });
            }}
          />
          {connections.map((c) => (
            <Toggle
              key={c.mac.id}
              label={c.mac.name}
              on={selectedMacs.includes(c.mac.id)}
              onPress={() => {
                hapticFeedback('selection');
                update({ macs: toggled(selectedMacs, c.mac.id) });
              }}
            />
          ))}
        </Group>
      ) : null}
      {projects.length > 1 ? (
        <Group title={t`Projects`}>
          <Toggle
            label={t`All`}
            on={filters.projects.length === 0}
            onPress={() => {
              if (filters.projects.length > 0) hapticFeedback('selection');
              update({ projects: [] });
            }}
          />
          {projects.map((project) => (
            <Toggle
              key={project}
              label={project}
              on={filters.projects.includes(project)}
              onPress={() => {
                hapticFeedback('selection');
                update({ projects: toggled(filters.projects, project) });
              }}
            />
          ))}
        </Group>
      ) : null}
      <View style={styles.switches}>
        <Host matchContents seedColor={theme.colors.primary}>
          <Switch
            label={t`Has errors`}
            value={filters.errorsOnly}
            onValueChange={(errorsOnly) => update({ errorsOnly })}
          />
        </Host>
        <Host matchContents seedColor={theme.colors.primary}>
          <Switch
            label={t`Has remote sessions`}
            value={filters.remoteOnly}
            onValueChange={(remoteOnly) => update({ remoteOnly })}
          />
        </Host>
      </View>
      <Text variant="caption" tone="tertiary">
        <Trans>Filters are saved on this phone.</Trans>
      </Text>
    </SheetScreen>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <SectionHeader title={title} />
      <View style={styles.toggles}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.space.md },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  switches: { gap: theme.space.lg, alignItems: 'flex-start' },
}));
