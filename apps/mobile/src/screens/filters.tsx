import { Host } from '@expo/ui';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TextInput, View, type TextInputInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { SectionHeader } from '@/components/list';
import { SheetScreen } from '@/components/sheet-screen';
import { Switch } from '@/components/switch';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { Touch } from '@/components/touch';
import { useHomeFilters } from '@/hooks/home-filters';
import { useArchiveItems, useMacs, useWorkspaceItems, useWorktreeItems } from '@/hooks/machines';
import { hapticFeedback } from '@/lib/haptics';
import { keepProjectOrder, projectNames, projectsByActivity, visibleProjects, type ActivityFilter } from '@/lib/home';

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
  const [searchShown, setSearchShown] = useState(false);
  const searchInput = useRef<TextInputInstance>(null);
  const [projectOrder, setProjectOrder] = useState(() =>
    projectsByActivity([...workspaces, ...worktrees, ...archives]),
  );
  const currentProjects = useMemo(
    () => projectNames([...workspaces, ...worktrees, ...archives]),
    [workspaces, worktrees, archives],
  );
  const projects = keepProjectOrder(projectOrder, currentProjects);
  if (projects.length !== projectOrder.length || projects.some((project, index) => project !== projectOrder[index])) {
    setProjectOrder(projects);
  }
  const canSearch = projects.length > 12;
  const visible = visibleProjects({
    sorted: projects,
    selected: filters.projects,
    query: canSearch ? query : '',
    expanded,
  });
  const hidden = projects.length - visible.projects.length;
  const search = canSearch ? query.trim().toLowerCase() : '';
  useEffect(() => {
    if (canSearch && searchShown) searchInput.current?.focus();
  }, [canSearch, searchShown]);
  const activity: { value: ActivityFilter; label: string }[] = [
    { value: 'live', label: t`Live` },
    { value: 'idle', label: t`Idle` },
    { value: 'all', label: t`All` },
    { value: 'archived', label: t`Archived` },
  ];
  const selectedMacs = filters.macs.filter((id) => connections.some((c) => c.mac.id === id));
  const options: {
    key: string;
    label: string;
    detail?: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }[] = [
    {
      key: 'errors',
      label: t`Has errors`,
      detail: t`Errors in the logs`,
      value: filters.errorsOnly,
      onChange: (errorsOnly) => update({ errorsOnly }),
    },
    {
      key: 'remote',
      label: t`Has remote sessions`,
      value: filters.remoteOnly,
      onChange: (remoteOnly) => update({ remoteOnly }),
    },
  ];

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
          <SectionHeader
            title={t`Projects`}
            action={
              canSearch ? (
                <Touch
                  accessibilityLabel={t`Search projects`}
                  hitSlop={12}
                  onPress={() => {
                    if (searchShown) setQuery('');
                    setSearchShown((shown) => !shown);
                  }}
                >
                  <Icon name="magnifyingglass" size={20} color={theme.colors.secondary} />
                </Touch>
              ) : null
            }
          />
          {canSearch && searchShown ? (
            <TextInput
              ref={searchInput}
              autoFocus
              value={query}
              onChangeText={setQuery}
              onBlur={() => {
                if (!query) setSearchShown(false);
              }}
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
            {visible.showToggle ? (
              <ProjectExpansionChip
                expanded={expanded}
                hidden={hidden}
                onPress={() => setExpanded((value) => !value)}
              />
            ) : null}
          </View>
          {search && !projects.some((project) => project.toLowerCase().includes(search)) ? (
            <Text variant="footnote" tone="tertiary">
              {t`No matching projects`}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.group}>
        <SectionHeader title={t`Options`} />
        <View>
          {options.map(({ key, label, detail, value, onChange }, index) => (
            <View key={key}>
              {index > 0 ? <View style={styles.optionDivider} /> : null}
              <Touch
                feedback="row"
                accessibilityRole="switch"
                accessibilityLabel={label}
                accessibilityHint={detail}
                accessibilityState={{ checked: value }}
                onPress={() => onChange(!value)}
                style={styles.optionRow}
              >
                <View style={styles.optionTitles}>
                  <Text variant="body">{label}</Text>
                  {detail ? (
                    <Text variant="footnote" tone="secondary">
                      {detail}
                    </Text>
                  ) : null}
                </View>
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <Host matchContents seedColor={theme.colors.primary}>
                    <Switch value={value} onValueChange={onChange} />
                  </Host>
                </View>
              </Touch>
            </View>
          ))}
        </View>
      </View>
      <Text variant="caption" tone="tertiary">
        <Trans>Filters are saved on this phone.</Trans>
      </Text>
    </SheetScreen>
  );
}

function ProjectExpansionChip({
  expanded,
  hidden,
  onPress,
}: {
  expanded: boolean;
  hidden: number;
  onPress: () => void;
}) {
  return (
    <Touch
      accessibilityRole="button"
      accessibilityLabel={expanded ? t`Show fewer projects` : t`Show ${hidden} more projects`}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
      style={styles.projectExpansionChip}
    >
      <Text variant="footnote" weight="medium" tone="secondary">
        {expanded ? t`Show less` : t`${hidden} more`}
      </Text>
    </Touch>
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
  optionRow: {
    minHeight: theme.space.giant,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  optionTitles: { flex: 1, gap: theme.space.xxs },
  optionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.separator,
  },
  projectExpansionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.xs,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
    backgroundColor: 'transparent',
  },
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
