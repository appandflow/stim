import { Chip } from '@/components/chip';
import { useNow } from '@/hooks/use-now';
import { activityBadge } from '@/lib/format';
import type { DeviceActivity } from '@/protocol/types';
import { useColors } from '@/theme';

export function ActivityChip({ activity, frozenAt }: { activity?: DeviceActivity; frozenAt?: number | null }) {
  const colors = useColors();
  const ticking = useNow(30_000);
  const badge = activityBadge(activity, frozenAt ?? ticking);
  if (!badge) return null;
  const tint = badge.kind === 'driven' ? colors.accent : colors.tertiary;
  return <Chip tint={tint}>{badge.text}</Chip>;
}
