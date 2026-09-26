import { Host, Picker, Switch } from '@expo/ui';
import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ConnectionBanner } from '@/components/connection-banner';
import { FlatList, ScrollView } from '@/components/lists';
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
import type { LogLevel, LogRecord } from '@/protocol/types';
import { mono, useColors, type Colors } from '@/theme';

const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label]));

export function Logs({
  path,
  params,
}: {
  path: string;
  params: { errors?: string; source?: string; slot?: string; at?: string };
}) {
  const colors = useColors();
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
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: `Logs \u00B7 ${workspaceTitleAt(path, status)}` }} />
      <ConnectionBanner state={state} />
      <View style={[styles.filters, { borderBottomColor: colors.border }]}>
        <View style={styles.row}>
          {SOURCES.map(({ source, label }) => (
            <Toggle
              key={source}
              colors={colors}
              label={label}
              on={filter.sources.includes(source)}
              onPress={() => toggleSource(source)}
            />
          ))}
        </View>
        {slots.length > 1 ? (
          <View style={styles.row}>
            <Toggle
              colors={colors}
              label="All slots"
              on={active.slot === null}
              onPress={() => update({ slot: null })}
            />
            {slots.map((slot) => (
              <Toggle
                key={slot}
                colors={colors}
                label={slot}
                on={active.slot === slot}
                onPress={() => update({ slot })}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.row}>
          <Host matchContents seedColor={colors.primary}>
            <Picker selectedValue={filter.level} onValueChange={(level) => update({ level: level as LogLevel })}>
              {LEVELS.map((level) => (
                <Picker.Item key={level} label={level === 'debug' ? 'All levels' : `${level} and up`} value={level} />
              ))}
            </Picker>
          </Host>
          <View style={styles.spacer} />
          <Host matchContents seedColor={colors.primary}>
            <Switch label="Errors only" value={filter.errors} onValueChange={(errors) => update({ errors })} />
          </Host>
        </View>
        <TextInput
          value={grepDraft}
          onChangeText={setGrepDraft}
          onSubmitEditing={applyGrep}
          onBlur={applyGrep}
          placeholder="Search (regular expression)"
          placeholderTextColor={colors.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search logs"
          style={[styles.search, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
        />
        {problem ? <Text style={[styles.problem, { color: colors.error }]}>{problem}</Text> : null}
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
          <Text style={[styles.empty, { color: colors.tertiary }]}>No records match these filters.</Text>
        }
        renderItem={({ item }) => {
          const context = fetched.get(item.key);
          return (
            <LogRow
              colors={colors}
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
          style={[styles.jump, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.jumpText, { color: colors.onPrimary }]}>Jump to latest</Text>
        </Touch>
      ) : null}
    </View>
  );
}

function levelColor(colors: Colors, level: string): string {
  if (level === 'error' || level === 'fatal') return colors.error;
  if (level === 'warn') return colors.warn;
  if (level === 'debug') return colors.tertiary;
  return colors.secondary;
}

function LogRow({
  colors,
  entry,
  workspace,
  home,
  expanded,
  onPress,
}: {
  colors: Colors;
  entry: LogEntry;
  workspace: string;
  home: string | null;
  expanded: boolean;
  onPress: () => void;
}) {
  const record = entry.lead;
  const time = new Date(record.ts).toTimeString().slice(0, 8);
  const tint = levelColor(colors, record.level);
  const error = record.level === 'error' || record.level === 'fatal';
  const view = viewEntry(entry, workspace, home);
  const [copied, setCopied] = useState(false);
  return (
    <Touch
      feedback="row"
      onPress={onPress}
      accessibilityRole="none"
      style={[styles.logRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.levelBar, { backgroundColor: tint }]} />
      <View style={styles.logBody}>
        <Text style={[styles.logMeta, { color: colors.tertiary }]}>
          {time} {SOURCE_LABEL[record.src] ?? record.src}
          {record.slot && record.slot !== 'default' ? ` \u00B7 ${record.slot}` : ''} {record.level}
          {entry.related.length > 0 ? ` \u00B7 ${entry.related.length + 1} records` : ''}
        </Text>
        <Text
          style={[styles.logText, error && styles.title, { color: error ? tint : colors.text }]}
          numberOfLines={expanded ? undefined : 3}
          selectable={expanded}
        >
          {view.title}
        </Text>
        {view.location ? (
          <Text
            style={[styles.location, { color: colors.text }]}
            numberOfLines={expanded ? undefined : 1}
            selectable={expanded}
          >
            {view.location}
          </Text>
        ) : null}
        {expanded && view.codeFrame.length > 0 ? (
          <View style={[styles.codeFrame, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={[styles.logText, { color: colors.text }]} selectable>
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
              style={[styles.action, { borderColor: colors.border }]}
            >
              <Text style={[styles.actionText, { color: colors.primary }]}>{copied ? 'Copied' : 'Copy'}</Text>
            </Touch>
            <Touch
              onPress={() => void Share.share({ message: shareText(view, entry, workspace) }).catch(() => {})}
              accessibilityLabel="Share entry"
              style={[styles.action, { borderColor: colors.border }]}
            >
              <Text style={[styles.actionText, { color: colors.primary }]}>Share</Text>
            </Touch>
          </View>
        ) : null}
        {expanded && view.details.length > 0 ? (
          <Text style={[styles.logText, { color: colors.secondary }]} selectable>
            {view.details.join('\n')}
          </Text>
        ) : null}
      </View>
    </Touch>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  filters: { padding: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  spacer: { flex: 1 },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  problem: { fontSize: 13 },
  empty: { textAlign: 'center', padding: 32, fontSize: 14 },
  logRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  levelBar: { width: 3 },
  logBody: { flex: 1, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
  logMeta: { fontSize: 11, fontFamily: mono },
  logText: { fontSize: 12, fontFamily: mono, lineHeight: 17 },
  title: { fontSize: 13, fontWeight: '600' },
  location: { fontSize: 12, fontFamily: mono, fontWeight: '600' },
  codeFrame: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, marginVertical: 4 },
  actions: { flexDirection: 'row', gap: 8, paddingTop: 6 },
  action: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  actionText: { fontSize: 14, fontWeight: '600' },
  jump: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 32,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  jumpText: { fontSize: 14, fontWeight: '600' },
});
