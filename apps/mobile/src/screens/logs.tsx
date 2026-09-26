import { Host, Picker, Switch } from '@expo/ui';
import { Stack } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ConnectionBanner } from '@/components/connection-banner';
import { Toggle } from '@/components/toggle';
import { useMacConnection, useLogs, useStatus, type LogsChange } from '@/hooks/mac-connection';
import {
  appendRecords,
  DEFAULT_FILTER,
  firstLine,
  LEVELS,
  logFilter,
  SOURCES,
  stackLines,
  type LogFilterState,
} from '@/lib/logs';
import { workspaceTitleAt } from '@/lib/workspaces';
import type { LogLevel, LogRecord } from '@/protocol/types';
import { mono, useColors, type Colors } from '@/theme';

const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label]));

export function Logs({ path, errorsOnly }: { path: string; errorsOnly: boolean }) {
  const colors = useColors();
  const { state } = useMacConnection();
  const status = useStatus();
  const env = status?.environments.find((e) => e.path === path);
  const slots = useMemo(() => ['default', ...(env?.slots ?? []).map((s) => s.slot)], [env?.slots]);
  const [filter, setFilter] = useState<LogFilterState>({ ...DEFAULT_FILTER, errors: errorsOnly });
  const [grepDraft, setGrepDraft] = useState('');
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<LogRecord>>(new Set());
  const [following, setFollowing] = useState(true);
  const list = useRef<FlatList<LogRecord>>(null);

  const [problem, setProblem] = useState<string | null>(null);
  const onLogs = useCallback((change: LogsChange) => {
    if (change.kind === 'records') return setRecords((existing) => appendRecords(existing, change.records));
    if (change.kind === 'error') return setProblem(change.message);
    setRecords([]);
    setExpanded(new Set());
    setProblem(null);
  }, []);
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
        data={records}
        keyExtractor={(_, index) => String(index)}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (following) list.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.tertiary }]}>No records match these filters.</Text>
        }
        renderItem={({ item }) => (
          <LogRow
            colors={colors}
            record={item}
            expanded={expanded.has(item)}
            onPress={() =>
              setExpanded((set) => {
                const next = new Set(set);
                if (!next.delete(item)) next.add(item);
                return next;
              })
            }
          />
        )}
      />
      {!following && records.length > 0 ? (
        <Pressable
          onPress={() => {
            setFollowing(true);
            list.current?.scrollToEnd({ animated: true });
          }}
          style={[styles.jump, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
        >
          <Text style={[styles.jumpText, { color: colors.onPrimary }]}>Jump to latest</Text>
        </Pressable>
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
  record,
  expanded,
  onPress,
}: {
  colors: Colors;
  record: LogRecord;
  expanded: boolean;
  onPress: () => void;
}) {
  const time = new Date(record.ts).toTimeString().slice(0, 8);
  const tint = levelColor(colors, record.level);
  const message = typeof record.msg === 'string' ? record.msg : '';
  const stack = expanded ? stackLines(record.stack) : [];
  return (
    <Pressable onPress={onPress} style={[styles.logRow, { borderBottomColor: colors.border }]}>
      <View style={[styles.levelBar, { backgroundColor: tint }]} />
      <View style={styles.logBody}>
        <Text style={[styles.logMeta, { color: colors.tertiary }]}>
          {time} {SOURCE_LABEL[record.src] ?? record.src}
          {record.slot && record.slot !== 'default' ? ` \u00B7 ${record.slot}` : ''} {record.level}
        </Text>
        <Text
          style={[styles.logText, { color: record.level === 'error' || record.level === 'fatal' ? tint : colors.text }]}
          numberOfLines={expanded ? undefined : 2}
          selectable={expanded}
        >
          {expanded ? message : firstLine(message)}
        </Text>
        {expanded && stack.length > 0 ? (
          <Text style={[styles.logText, { color: colors.secondary }]} selectable>
            {stack.join('\n')}
          </Text>
        ) : null}
      </View>
    </Pressable>
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
