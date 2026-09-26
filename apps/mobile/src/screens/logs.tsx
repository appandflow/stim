import { Host, Picker, Switch } from '@expo/ui';
import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Share, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ConnectionBanner } from '@/components/connection-banner';
import { FlatList, ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Toggle } from '@/components/toggle';
import { Touch } from '@/components/touch';
import { useMacConnection, useLogs, useStatus, type LogsChange } from '@/hooks/mac-connection';
import {
  appendRecords,
  copyText,
  expoContext,
  groupRecords,
  initialFilter,
  LEVELS,
  logFilter,
  MAX_RECORDS,
  needsContext,
  shareText,
  SOURCES,
  viewEntry,
  type LogEntry,
  type LogFilterState,
} from '@/lib/logs';
import { workspaceTitleAt } from '@/lib/workspaces';
import type { Theme } from '@/design/theme';
import type { LogLevel, LogRecord } from '@/protocol/types';

const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label]));

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
  const entries = useMemo(() => groupRecords(records), [records]);

  const [problem, setProblem] = useState<string | null>(null);
  const onLogs = useCallback(
    (change: LogsChange) => {
      if (change.kind === 'records') return setRecords((existing) => appendRecords(existing, change.records));
      if (change.kind === 'error') return setProblem(change.message);
      setRecords([]);
      setExpanded(new Set(opened ? [opened] : []));
      setFetched(new Map());
      generation.current += 1;
      setProblem(null);
    },
    [opened],
  );
  const active = env && filter.slot !== null && !slots.includes(filter.slot) ? { ...filter, slot: null } : filter;
  useLogs(logFilter(path, active), onLogs);

  const update = (patch: Partial<LogFilterState>) => setFilter((f) => ({ ...f, ...patch }));
  const toggleSource = (source: LogFilterState['sources'][number]) => {
    if (filter.sources.length === 1 && filter.sources[0] === source) return;
    update({
      sources: filter.sources.includes(source)
        ? filter.sources.filter((s) => s !== source)
        : [...filter.sources, source],
    });
  };

  const applyGrep = () => {
    try {
      new RegExp(grepDraft);
    } catch (e) {
      return setProblem(`Invalid search: ${(e as Error).message}`);
    }
    setProblem(null);
    update({ grep: grepDraft });
  };

  const hidesContext = active.errors || active.level === 'warn' || active.level === 'error' || active.grep !== '';
  const fetchContext = (entry: LogEntry) => {
    if (!connection || !hidesContext || !needsContext(entry) || fetched.has(entry.key)) return;
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
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setFollowing(contentOffset.y + layoutMeasurement.height >= contentSize.height - 40);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `Logs \u00B7 ${workspaceTitleAt(path, status)}` }} />
      <ConnectionBanner state={state} />
      <View style={styles.filters}>
        <View style={styles.row}>
          {SOURCES.map(({ source, label }) => (
            <Toggle
              key={source}
              label={label}
              on={filter.sources.includes(source)}
              onPress={() => toggleSource(source)}
            />
          ))}
        </View>
        {slots.length > 1 ? (
          <View style={styles.row}>
            <Toggle label="All slots" on={active.slot === null} onPress={() => update({ slot: null })} />
            {slots.map((slot) => (
              <Toggle key={slot} label={slot} on={active.slot === slot} onPress={() => update({ slot })} />
            ))}
          </View>
        ) : null}
        <View style={styles.row}>
          <Host matchContents seedColor={theme.colors.primary}>
            <Picker selectedValue={filter.level} onValueChange={(level) => update({ level: level as LogLevel })}>
              {LEVELS.map((level) => (
                <Picker.Item key={level} label={level === 'debug' ? 'All levels' : `${level} and up`} value={level} />
              ))}
            </Picker>
          </Host>
          <View style={styles.spacer} />
          <Host matchContents seedColor={theme.colors.primary}>
            <Switch label="Errors only" value={filter.errors} onValueChange={(errors) => update({ errors })} />
          </Host>
        </View>
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
        onScroll={onScroll}
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
              onPress={() => {
                if (!expanded.has(item.key)) fetchContext(item);
                setExpanded((set) => {
                  const next = new Set(set);
                  if (!next.delete(item.key)) next.add(item.key);
                  return next;
                });
              }}
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

function levelColor(theme: Theme, level: string): string {
  if (level === 'error' || level === 'fatal') return theme.colors.error;
  if (level === 'warn') return theme.colors.warning;
  if (level === 'debug') return theme.colors.tertiary;
  return theme.colors.secondary;
}

function LogRow({
  entry,
  workspace,
  home,
  expanded,
  onPress,
}: {
  entry: LogEntry;
  workspace: string;
  home: string | null;
  expanded: boolean;
  onPress: () => void;
}) {
  const record = entry.lead;
  const time = new Date(record.ts).toTimeString().slice(0, 8);
  const error = record.level === 'error' || record.level === 'fatal';
  const view = viewEntry(entry, workspace, home);
  const [copied, setCopied] = useState(false);
  return (
    <Touch feedback="row" onPress={onPress} accessibilityRole="none" style={styles.logRow}>
      <View style={styles.levelBar(record.level)} />
      <View style={styles.logBody}>
        <Text variant="caption2" tone="tertiary" mono>
          {time} {SOURCE_LABEL[record.src] ?? record.src}
          {record.slot && record.slot !== 'default' ? ` \u00B7 ${record.slot}` : ''} {record.level}
          {entry.related.length > 0 ? ` \u00B7 ${entry.related.length + 1} records` : ''}
        </Text>
        <Text
          variant={error ? 'footnote' : 'caption'}
          weight={error ? 'semibold' : undefined}
          tone={error ? 'error' : 'default'}
          mono
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
      </View>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  filters: {
    padding: theme.space.lg,
    gap: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.sm },
  spacer: { flex: 1 },
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
  logRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border },
  levelBar: (level: string) => ({ width: 3, backgroundColor: levelColor(theme, level) }),
  logBody: { flex: 1, paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm, gap: theme.space.xxs },
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
