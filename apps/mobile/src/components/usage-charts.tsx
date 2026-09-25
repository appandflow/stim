import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { STAT_ICON, toneColor } from '@/components/machine-stats';
import type { StimConnection } from '@/lib/connection';
import { HISTORY_WINDOW_MS, type UsageChart, type UsageTone } from '@/lib/home';
import type { MachineUsage, UsageSample } from '@/protocol/types';
import { useColors, type Colors } from '@/theme';

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

function fillColor(tone: UsageTone, colors: Colors): string {
  return tone === 'normal' ? colors.accent : toneColor(tone, colors);
}

function Chart({ chart }: { chart: UsageChart }) {
  const colors = useColors();
  const lastIndex = chart.columns.findLastIndex((column) => column !== null);
  const last = chart.columns[lastIndex];
  return (
    <View style={styles.chart} accessibilityLabel={`${chart.label} over the last hour, now ${chart.value}`}>
      <View style={styles.header}>
        <Icon name={STAT_ICON[chart.kind]} size={13} color={colors.secondary} />
        <Text style={[styles.label, { color: colors.secondary }]}>{chart.label}</Text>
        <Text style={[styles.value, { color: fillColor(chart.tone, colors) }]}>{chart.value}</Text>
      </View>
      <View style={[styles.plot, { borderColor: colors.border }]}>
        {GRID_LINES.map((line) => (
          <View key={line} style={[styles.grid, { bottom: line * CHART_HEIGHT, backgroundColor: colors.border }]} />
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
                      backgroundColor: `${fillColor(column.tone, colors)}40`,
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
  const colors = useColors();
  return (
    <View style={styles.charts}>
      {charts.map((chart) => (
        <Chart key={chart.kind} chart={chart} />
      ))}
      <View style={styles.axis}>
        <Text style={[styles.axisLabel, { color: colors.tertiary }]}>60 min ago</Text>
        <Text style={[styles.axisLabel, { color: colors.tertiary }]}>now</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  charts: { gap: 14 },
  chart: { gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { fontSize: 13, flex: 1 },
  value: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  plot: { height: CHART_HEIGHT, borderBottomWidth: StyleSheet.hairlineWidth, marginRight: 4 },
  grid: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, opacity: 0.7 },
  columns: { ...StyleSheet.absoluteFill, flexDirection: 'row', alignItems: 'flex-end' },
  column: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  area: { borderTopWidth: 1.5 },
  dot: { position: 'absolute', width: 8, height: 8, marginLeft: -4, borderRadius: 4, borderWidth: 1.5 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -6 },
  axisLabel: { fontSize: 11, fontVariant: ['tabular-nums'] },
});
