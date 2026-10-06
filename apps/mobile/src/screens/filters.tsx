import { Host } from '@expo/ui';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { SectionHeader } from '@/components/list';
import { SheetScreen } from '@/components/sheet-screen';
import { Switch } from '@/components/switch';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { useHomeFilters } from '@/hooks/home-filters';
import { useArchiveItems, useMacs, useWorkspaceItems, useWorktreeItems } from '@/hooks/machines';
import { hapticFeedback } from '@/lib/haptics';
import { projectsByActivity, visibleProjects, type ActivityFilter } from '@/lib/home';

const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export function Filters() {
  const { theme } = useUnistyles();
  const { connections } = useMacs();
  const { filters, update, reset } = useHomeFilters();
  const workspaces = useWorkspaceItems();
  const worktrees = useWorktreeItems();
  const archives = useArchiveItems();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const projects = useMemo(
    () => projectsByActivity([...workspaces, ...worktrees, ...archives]),
    [workspaces, worktrees, archives],
  );
  const visible = visibleProjects({ sorted: projects, selected: filters.projects, query, expanded });
  const projectCount = projects.length;
  const search = query.trim().toLowerCase();
  const activity: { value: ActivityFilter; label: string }[] = [
    { value: 'live', label: t`Live` },
    { value: 'idle', label: t`Idle` },
    { value: 'all', label: t`All` },
    { value: 'archived', label: t`Archived` },
  ];
  const selectedMacs = filters.macs.filter((id) => connections.some((c) => c.mac.id === id));

  return (
    <SheetScreen title={t`Filters`} gap="xxl" accessory={<Button title={t`Reset`} variant="plain" onPress={reset} />}>
      <Group title={t`Show`} footnote={t`All shows live and idle workspaces. Archived shows only removed worktrees.`}>
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
        <View style={styles.group}>
          <SectionHeader title={t`Projects`} />
          {projects.length > 12 ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t`Search projects`}
              placeholderTextColor={theme.colors.tertiary}
              accessibilityLabel={t`Search projects`}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.search}
            />
          ) : null}
          <View style={styles.toggles}>
            <Toggle
              label={t`All`}
              on={filters.projects.length === 0}
              onPress={() => {
                if (filters.projects.length > 0) hapticFeedback('selection');
                update({ projects: [] });
              }}
            />
            {visible.projects.map((project) => (
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
          </View>
          {search && !projects.some((project) => project.toLowerCase().includes(search)) ? (
            <Text variant="footnote" tone="tertiary">
              {t`No matching projects`}
            </Text>
          ) : null}
          {visible.showToggle ? (
            <Button
              title={expanded ? t`Show fewer` : t`Show all (${projectCount})`}
              variant="plain"
              onPress={() => setExpanded((value) => !value)}
              style={styles.projectToggle}
            />
          ) : null}
        </View>
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

function Group({ title, children, footnote }: { title: string; children: ReactNode; footnote?: string }) {
  return (
    <View style={styles.group}>
      <SectionHeader title={title} />
      <View style={styles.toggles}>{children}</View>
      {footnote ? (
        <Text variant="caption" tone="tertiary">
          {footnote}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.space.md },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  switches: { gap: theme.space.lg, alignItems: 'flex-start' },
  projectToggle: { alignSelf: 'flex-start' },
  search: {
    borderWidth: 1,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    fontSize: theme.typography.callout.fontSize,
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
}));
