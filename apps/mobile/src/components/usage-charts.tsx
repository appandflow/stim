import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { STAT_ICON, toneColor } from '@/components/machine-stats';
import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import type { StimConnection } from '@/lib/connection';
import { HISTORY_WINDOW_MS, type UsageChart, type UsageTone } from '@/lib/home';
import type { MachineUsage, UsageSample } from '@/protocol/types';

const CHART_HEIGHT = 48;
const GRID_LINES = [0.25, 0.5, 0.75];

function merge(current: UsageSample[], incoming: UsageSample[]): UsageSample[] {
  const last = current.at(-1)?.at ?? -Infinity;
  const next = [...current, ...incoming.filter((sample) => sample.at > last)];
  const start = (next.at(-1)?.at ?? 0) - HISTORY_WINDOW_MS;
  return next.filter((sample) => sample.at > start);
}

export function useUsageHistory(connection: StimConnection | null, open: boolean, usage: MachineUsage | null) {
  const [samples, setSamples] = useState<UsageSample[] | null>(null);
  const lastAt = useRef<number | undefined>(undefined);
  const loaded = samples !== null;

  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    connection.request('machine.history', {}).then(
      (history) => !cancelled && setSamples(merge([], history.samples)),
      () => !cancelled && setSamples(null),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open]);

  useEffect(() => {
    lastAt.current = samples?.at(-1)?.at;
  }, [samples]);

  useEffect(() => {
    if (!connection || !open || !usage || !loaded) return;
    let cancelled = false;
    const sinceMs = lastAt.current;
    connection.request('machine.history', sinceMs === undefined ? {} : { sinceMs }).then(
      (history) => !cancelled && setSamples((current) => merge(current ?? [], history.samples)),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open, usage, loaded]);

  return samples;
}

function fillColor(tone: UsageTone, colors: Theme['colors']): string {
  return tone === 'normal' ? colors.accent : toneColor(tone, colors);
}

function Chart({ chart }: { chart: UsageChart }) {
  const { theme } = useUnistyles();
  const colors = theme.colors;
  const lastIndex = chart.columns.findLastIndex((column) => column !== null);
  const last = chart.columns[lastIndex];
  return (
    <View style={styles.chart} accessibilityLabel={`${chart.label} over the last hour, now ${chart.value}`}>
      <View style={styles.header}>
        <Icon name={STAT_ICON[chart.kind]} size={13} color={colors.secondary} />
        <Text variant="footnote" tone="secondary" style={styles.label}>
          {chart.label}
        </Text>
        <Text variant="headline" weight="bold" style={[styles.value, { color: fillColor(chart.tone, colors) }]}>
          {chart.value}
        </Text>
      </View>
      <View style={styles.plot}>
        {GRID_LINES.map((line) => (
          <View key={line} style={[styles.grid, { bottom: line * CHART_HEIGHT }]} />
        ))}
        <View style={styles.columns}>
          {chart.columns.map((column, i) => (
            <View key={i} style={styles.column}>
              {column ? (
                <View
                  style={[
                    styles.area,
                    {
                      height: Math.max(2, column.fraction * CHART_HEIGHT),
                      backgroundColor: withAlpha(fillColor(column.tone, colors), theme.opacity.track),
                      borderTopColor: fillColor(column.tone, colors),
                    },
                  ]}
                />
              ) : null}
            </View>
          ))}
        </View>
        {last ? (
          <View
            style={[
              styles.dot,
              {
                bottom: Math.max(2, last.fraction * CHART_HEIGHT) - 4,
                left: `${((lastIndex + 1) / chart.columns.length) * 100}%`,
                backgroundColor: fillColor(chart.tone, colors),
                borderColor: colors.surface,
              },
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}

export function UsageCharts({ charts }: { charts: UsageChart[] }) {
  return (
    <View style={styles.charts}>
      {charts.map((chart) => (
        <Chart key={chart.kind} chart={chart} />
      ))}
      <View style={styles.axis}>
        <Text variant="caption2" tone="tertiary" style={styles.tabular}>
          60 min ago
        </Text>
        <Text variant="caption2" tone="tertiary" style={styles.tabular}>
          now
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  charts: { gap: theme.space.lg },
  chart: { gap: theme.space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  label: { flex: 1 },
  value: { fontVariant: ['tabular-nums'] },
  plot: {
    height: CHART_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    marginRight: theme.space.xs,
  },
  grid: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    opacity: 0.7,
    backgroundColor: theme.colors.border,
  },
  columns: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'flex-end' },
  column: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  area: { borderTopWidth: 1.5 },
  dot: { position: 'absolute', width: 8, height: 8, marginLeft: -4, borderRadius: 4, borderWidth: 1.5 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -theme.space.sm },
  tabular: { fontVariant: ['tabular-nums'] },
}));
