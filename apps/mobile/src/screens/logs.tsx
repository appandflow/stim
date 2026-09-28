import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Share, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ConnectionBanner } from '@/components/connection-banner';
import { FlatList, ScrollView } from '@/components/lists';
import { StatusDot } from '@/components/pill';
import { PlatformLogo } from '@/components/platform-logo';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { Touch } from '@/components/touch';
import { useMacConnection, useLogs, useStatus, type LogsChange } from '@/hooks/mac-connection';
import {
  appendRecords,
  chipOf,
  CHIPS,
  copyText,
  expoContext,
  groupRecords,
  initialFilter,
  lastBundleMs,
  logFilter,
  MAX_RECORDS,
  needsContext,
  presentChips,
  shareText,
  showsEntry,
  stackPreview,
  viewEntry,
  type LogChip,
  type LogEntry,
  type LogFilterState,
  type Severity,
} from '@/lib/logs';
import { workspaceTitleAt } from '@/lib/workspaces';
import type { Theme } from '@/design/theme';
import type { EnvironmentState, LogRecord } from '@/protocol/types';

const CHIP_LABEL = Object.fromEntries(CHIPS.map((c) => [c.chip, c.label])) as Record<LogChip, string>;

export function Logs({
  path,
  params,
}: {
  path: string;
  params: { errors?: string; source?: string; slot?: string; at?: string };
}) {
  const { theme } = useUnistyles();
  const { state, home, connection } = useMacConnection();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const slots = useMemo(() => ['default', ...(env?.slots ?? []).map((s) => s.slot)], [env?.slots]);
  const [filter, setFilter] = useState<LogFilterState>(() => initialFilter(params));
  const [grepDraft, setGrepDraft] = useState('');
  const [records, setRecords] = useState<LogRecord[]>([]);
  const opened = params.at ? `${params.at}:0` : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(opened ? [opened] : []));
  const [fetched, setFetched] = useState<Map<string, string[]>>(new Map());
  const generation = useRef(0);
  const [following, setFollowing] = useState(true);
  const list = useRef<FlatList<LogEntry>>(null);
  const [seen, setSeen] = useState<ReadonlySet<LogChip>>(new Set());
  const grouped = useMemo(() => groupRecords(records), [records]);
  const entries = useMemo(() => grouped.filter((entry) => showsEntry(filter, entry)), [grouped, filter]);
  const warnings = useMemo(
    () => (filter.severity === 'errors' ? undefined : entries.filter((e) => e.lead.level === 'warn').length),
    [entries, filter.severity],
  );
  const bundleMs = useMemo(() => lastBundleMs(records), [records]);

  const [problem, setProblem] = useState<string | null>(null);
  const onLogs = useCallback(
    (change: LogsChange) => {
      if (change.kind === 'records') {
        setSeen((existing) => {
          const added = change.records.map(chipOf).filter((c): c is LogChip => c !== null && !existing.has(c));
          return added.length === 0 ? existing : new Set([...existing, ...added]);
        });
        return setRecords((existing) => appendRecords(existing, change.records));
      }
      if (change.kind === 'error') return setProblem(change.message);
      setRecords([]);
      setFollowing(true);
      setExpanded(new Set(opened ? [opened] : []));
      setFetched(new Map());
      generation.current += 1;
      setProblem(null);
    },
    [opened],
  );
  const active = env && filter.slot !== null && !slots.includes(filter.slot) ? { ...filter, slot: null } : filter;
  useLogs(logFilter(path, active), onLogs);

  const update = (patch: Partial<LogFilterState>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setFollowing(true);
  };
  const toggleChip = (chip: LogChip) =>
    update({ chips: filter.chips.includes(chip) ? filter.chips.filter((c) => c !== chip) : [...filter.chips, chip] });
  const chips = presentChips(env, seen, filter.chips);

  const applyGrep = () => {
    try {
      new RegExp(grepDraft);
    } catch (e) {
      return setProblem(`Invalid search: ${(e as Error).message}`);
    }
    setProblem(null);
    update({ grep: grepDraft });
  };

  const hidesContext = active.severity !== 'all' || active.grep !== '';
  const onToggle = useCallback(
    (entry: LogEntry, open: boolean) => {
      if (!open && connection && hidesContext && needsContext(entry) && !fetched.has(entry.key)) {
        const started = generation.current;
        setFetched((map) => new Map(map).set(entry.key, []));
        connection
          .request('logs.query', { workspace: path, sources: ['metro'], tail: MAX_RECORDS })
          .then(({ records: metro }) => {
            const context = expoContext(metro, entry.lead).map((r) => r.msg);
            if (context.length > 0 && generation.current === started)
              setFetched((map) => new Map(map).set(entry.key, context));
          })
          .catch(() => {});
      }
      setExpanded((set) => {
        const next = new Set(set);
        if (!next.delete(entry.key)) next.add(entry.key);
        return next;
      });
    },
    [connection, hidesContext, fetched, path],
  );

  const dragging = useRef(false);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setFollowing(contentOffset.y + layoutMeasurement.height >= contentSize.height - 40);
  };

  const severity = (value: Severity) => () => update({ severity: value });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `Logs · ${workspaceTitleAt(path, status)}` }} />
      <ConnectionBanner state={state} />
      <View style={styles.filters}>
        <MetroLine metro={env?.metro} bundleMs={bundleMs} />
        <View style={styles.row}>
          <Toggle label="All" on={filter.severity === 'all'} onPress={severity('all')} />
          <Toggle
            label="Errors"
            count={env?.logs?.errorsSinceMarker}
            countTone="error"
            on={filter.severity === 'errors'}
            onPress={severity('errors')}
          />
          <Toggle
            label="Warnings"
            count={warnings}
            countTone="warning"
            on={filter.severity === 'warnings'}
            onPress={severity('warnings')}
          />
        </View>
        {chips.length > 0 ? (
          <View style={styles.row}>
            {chips.map((chip) => {
              const on = filter.chips.includes(chip);
              return (
                <Toggle
                  key={chip}
                  label={CHIP_LABEL[chip]}
                  icon={
                    chip === 'ios' || chip === 'android' || chip === 'web' ? (
                      <PlatformLogo
                        platform={chip}
                        size={13}
                        color={on ? theme.colors.primary : theme.colors.secondary}
                      />
                    ) : null
                  }
                  on={on}
                  onPress={() => toggleChip(chip)}
                />
              );
            })}
          </View>
        ) : null}
        {slots.length > 1 ? (
          <View style={styles.row}>
            <Toggle label="All slots" on={active.slot === null} onPress={() => update({ slot: null })} />
            {slots.map((slot) => (
              <Toggle key={slot} label={slot} on={active.slot === slot} onPress={() => update({ slot })} />
            ))}
          </View>
        ) : null}
        <TextInput
          value={grepDraft}
          onChangeText={setGrepDraft}
          onSubmitEditing={applyGrep}
          onBlur={applyGrep}
          placeholder="Search (regular expression)"
          placeholderTextColor={theme.colors.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search logs"
          style={styles.search}
        />
        {problem ? (
          <Text variant="footnote" tone="error">
            {problem}
          </Text>
        ) : null}
      </View>
      <FlatList
        ref={list}
        data={entries}
        keyExtractor={(entry) => entry.key}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScroll={(e) => {
          if (dragging.current) settle(e);
        }}
        onScrollEndDrag={(e) => {
          dragging.current = false;
          settle(e);
        }}
        onMomentumScrollEnd={settle}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (following) list.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            No records match these filters.
          </Text>
        }
        renderItem={({ item }) => {
          const context = fetched.get(item.key);
          return (
            <LogRow
              entry={context && context.length > 0 ? { ...item, context } : item}
              workspace={path}
              home={home}
              expanded={expanded.has(item.key)}
              onToggle={onToggle}
            />
          );
        }}
      />
      {!following && entries.length > 0 ? (
        <Touch
          feedback="card"
          onPress={() => {
            setFollowing(true);
            list.current?.scrollToEnd({ animated: true });
          }}
          style={styles.jump}
        >
          <Text weight="semibold" tone="onBrand">
            Jump to latest
          </Text>
        </Touch>
      ) : null}
    </View>
  );
}

function MetroLine({ metro, bundleMs }: { metro: EnvironmentState['metro']; bundleMs: number | null }) {
  const { theme } = useUnistyles();
  if (!metro) return null;
  const parts = [metro.running ? 'running' : 'stopped'];
  if (bundleMs !== null) parts.push(`last bundle ${(bundleMs / 1000).toFixed(1)}s`);
  return (
    <View style={styles.metro}>
      <StatusDot color={metro.running ? theme.colors.success : theme.colors.tertiary} filled={metro.running} />
      <Text variant="footnote" weight="semibold">
        Metro :{metro.port}
      </Text>
      <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.shrink}>
        {parts.join(' · ')}
      </Text>
    </View>
  );
}

function levelColor(theme: Theme, level: string): string {
  if (level === 'error' || level === 'fatal') return theme.colors.error;
  if (level === 'warn') return theme.colors.warning;
  if (level === 'debug') return theme.colors.border;
  return theme.colors.tertiary;
}

const LogRow = memo(function LogRow({
  entry,
  workspace,
  home,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  workspace: string;
  home: string | null;
  expanded: boolean;
  onToggle: (entry: LogEntry, open: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const record = entry.lead;
  const time = new Date(record.ts).toTimeString().slice(0, 8);
  const error = record.level === 'error' || record.level === 'fatal';
  const chip = chipOf(record);
  const view = useMemo(() => viewEntry(entry, workspace, home), [entry, workspace, home]);
  const preview = useMemo(
    () => (expanded ? null : stackPreview(record.stack, workspace, home)),
    [expanded, record.stack, workspace, home],
  );
  const [copied, setCopied] = useState(false);
  return (
    <Touch feedback="row" onPress={() => onToggle(entry, expanded)} accessibilityRole="none" style={styles.logRow}>
      <View style={styles.meta}>
        <StatusDot color={levelColor(theme, record.level)} />
        <View style={styles.tag}>
          <Text variant="caption2" tone="secondary">
            {chip ? CHIP_LABEL[chip] : record.src}
          </Text>
        </View>
        <Text variant="caption2" tone="tertiary" numberOfLines={1} style={styles.shrink}>
          {time}
          {record.slot && record.slot !== 'default' ? ` · ${record.slot}` : ''}
          {entry.related.length > 0 ? ` · ${entry.related.length + 1} records` : ''}
        </Text>
      </View>
      <Text
        variant="footnote"
        weight={error ? 'medium' : undefined}
        numberOfLines={expanded ? undefined : 3}
        selectable={expanded}
      >
        {view.title}
      </Text>
      {view.location ? (
        <Text variant="caption" weight="semibold" mono numberOfLines={expanded ? undefined : 1} selectable={expanded}>
          {view.location}
        </Text>
      ) : null}
      {preview ? (
        <View style={styles.frames}>
          {preview.frames.map((frame, i) => (
            <Text
              key={i}
              variant="caption2"
              mono
              weight={frame.app ? 'semibold' : undefined}
              tone={frame.app ? 'default' : 'tertiary'}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {[frame.fn, frame.where].filter(Boolean).join('  ')}
            </Text>
          ))}
          {preview.hidden > 0 ? (
            <Text variant="caption2" tone="tertiary">
              +{preview.hidden} {preview.hiddenFramework ? 'framework frames' : 'more frames'}
            </Text>
          ) : null}
        </View>
      ) : null}
      {expanded && view.codeFrame.length > 0 ? (
        <View style={styles.codeFrame}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text variant="caption" mono selectable>
              {view.codeFrame.join('\n')}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      {expanded ? (
        <View style={styles.actions}>
          <Touch
            onPress={() => void Clipboard.setStringAsync(copyText(view)).then(() => setCopied(true))}
            accessibilityLabel="Copy message and location"
            style={styles.action}
          >
            <Text weight="semibold" tone="brand">
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Touch>
          <Touch
            onPress={() => void Share.share({ message: shareText(view, entry, workspace) }).catch(() => {})}
            accessibilityLabel="Share entry"
            style={styles.action}
          >
            <Text weight="semibold" tone="brand">
              Share
            </Text>
          </Touch>
        </View>
      ) : null}
      {expanded && view.details.length > 0 ? (
        <Text variant="caption" tone="secondary" mono selectable>
          {view.details.join('\n')}
        </Text>
      ) : null}
    </Touch>
  );
});

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  filters: {
    padding: theme.space.lg,
    gap: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  metro: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  shrink: { flexShrink: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.sm },
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
  empty: { textAlign: 'center', padding: theme.space.huge },
  logRow: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    gap: theme.space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.separator,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  tag: {
    paddingHorizontal: theme.space.sm,
    paddingVertical: 1,
    borderRadius: theme.radius.small,
    backgroundColor: theme.colors.raised,
  },
  frames: {
    gap: theme.space.xxs,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.sidebar,
  },
  codeFrame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.control,
    padding: theme.space.md,
    marginVertical: theme.space.xs,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  actions: { flexDirection: 'row', gap: theme.space.md, paddingTop: theme.space.sm },
  action: {
    borderWidth: 1,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderColor: theme.colors.border,
  },
  jump: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: theme.space.huge,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
    borderRadius: theme.radius.sheet,
    backgroundColor: theme.colors.primary,
  },
}));
