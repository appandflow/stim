import { StatRow } from '@/components/stat-row';
import { machineStats, usageTone } from '@/lib/home';
import type { MachineUsage } from '@/protocol/types';

/** The CPU, RAM and disk stats as a compact icon+value row. Shared by the machine chip and the status sheet. */
export function MachineStatsRow({ usage, large }: { usage: MachineUsage | null; large?: boolean }) {
  const stats = machineStats(usage);
  if (stats.length === 0) return null;
  return (
    <StatRow
      wrap
      accessible
      stats={stats.map((stat) => ({ kind: stat.kind, value: stat.value, tone: usageTone(stat.tone) }))}
      iconSize={large ? 15 : 12}
      variant={large ? 'callout' : 'caption'}
      weight={large ? 'medium' : undefined}
      accessibilityLabel={stats.map((s) => `${s.label} ${s.value}`).join(', ')}
    />
  );
}
