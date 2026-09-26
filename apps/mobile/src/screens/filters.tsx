import { Host, Switch } from '@expo/ui';
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ScrollView } from '@/components/lists';
import { Toggle } from '@/components/toggle';
import { Touch } from '@/components/touch';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { mergeWorkspaces, projectNames, type ActivityFilter } from '@/lib/home';
import { useColors } from '@/theme';

const ACTIVITY: { value: ActivityFilter; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'idle', label: 'Idle' },
  { value: 'all', label: 'All' },
];

const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export function Filters() {
  const colors = useColors();
  const { connections } = useMacs();
  const { filters, update, reset } = useHomeFilters();
  const projects = useMemo(
    () => projectNames(mergeWorkspaces(connections.map((c) => ({ id: c.mac.id, name: c.mac.name, status: c.status })))),
    [connections],
  );
  const selectedMacs = filters.macs.filter((id) => connections.some((c) => c.mac.id === id));

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: colors.background }}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>Filters</Text>
        <Touch onPress={reset} hitSlop={8}>
          <Text style={[styles.reset, { color: colors.primary }]}>Reset</Text>
        </Touch>
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
        <Host matchContents seedColor={colors.primary}>
          <Switch
            label="Has errors"
            value={filters.errorsOnly}
            onValueChange={(errorsOnly) => update({ errorsOnly })}
          />
        </Host>
        <Host matchContents seedColor={colors.primary}>
          <Switch
            label="Has remote sessions"
            value={filters.remoteOnly}
            onValueChange={(remoteOnly) => update({ remoteOnly })}
          />
        </Host>
      </View>
      <Text style={[styles.note, { color: colors.tertiary }]}>Filters are saved on this phone.</Text>
    </ScrollView>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.group}>
      <Text style={[styles.groupTitle, { color: colors.tertiary }]}>{title}</Text>
      <View style={styles.toggles}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 28, gap: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, fontWeight: '700' },
  reset: { fontSize: 16, fontWeight: '500' },
  group: { gap: 8 },
  groupTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  switches: { gap: 12, alignItems: 'flex-start' },
  note: { fontSize: 12 },
});
