import { Host, Switch } from '@expo/ui';
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { SectionHeader } from '@/components/list';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { mergeWorkspaces, projectNames, type ActivityFilter } from '@/lib/home';

const ACTIVITY: { value: ActivityFilter; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'idle', label: 'Idle' },
  { value: 'all', label: 'All' },
];

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
  const selectedMacs = filters.macs.filter((id) => connections.some((c) => c.mac.id === id));

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.background }}>
      <View style={styles.titleRow}>
        <Text variant="title">Filters</Text>
        <Button title="Reset" variant="plain" onPress={reset} />
      </View>
      <Group title="Show">
        {ACTIVITY.map(({ value, label }) => (
          <Toggle
            key={value}
            label={label}
            on={filters.activity === value}
            onPress={() => update({ activity: value })}
          />
        ))}
      </Group>
      {connections.length > 1 ? (
        <Group title="Machines">
          <Toggle label="All" on={selectedMacs.length === 0} onPress={() => update({ macs: [] })} />
          {connections.map((c) => (
            <Toggle
              key={c.mac.id}
              label={c.mac.name}
              on={selectedMacs.includes(c.mac.id)}
              onPress={() => update({ macs: toggled(selectedMacs, c.mac.id) })}
            />
          ))}
        </Group>
      ) : null}
      {projects.length > 1 ? (
        <Group title="Projects">
          <Toggle label="All" on={filters.projects.length === 0} onPress={() => update({ projects: [] })} />
          {projects.map((project) => (
            <Toggle
              key={project}
              label={project}
              on={filters.projects.includes(project)}
              onPress={() => update({ projects: toggled(filters.projects, project) })}
            />
          ))}
        </Group>
      ) : null}
      <View style={styles.switches}>
        <Host matchContents seedColor={theme.colors.primary}>
          <Switch
            label="Has errors"
            value={filters.errorsOnly}
            onValueChange={(errorsOnly) => update({ errorsOnly })}
          />
        </Host>
        <Host matchContents seedColor={theme.colors.primary}>
          <Switch
            label="Has remote sessions"
            value={filters.remoteOnly}
            onValueChange={(remoteOnly) => update({ remoteOnly })}
          />
        </Host>
      </View>
      <Text variant="caption" tone="tertiary">
        Filters are saved on this phone.
      </Text>
    </ScrollView>
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
  container: { padding: theme.space.xxl, paddingTop: theme.space.huge, gap: theme.space.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  group: { gap: theme.space.md },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  switches: { gap: theme.space.lg, alignItems: 'flex-start' },
}));
