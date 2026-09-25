import { Chip } from '@/components/chip';
import { useNow } from '@/hooks/use-now';
import { activityBadge } from '@/lib/format';
import type { DeviceActivity } from '@/protocol/types';
import { useColors } from '@/theme';

export function ActivityChip({ activity }: { activity?: DeviceActivity }) {
  const colors = useColors();
  const now = useNow(30_000);
  const badge = activityBadge(activity, now);
  if (!badge) return null;
  const tint = badge.kind === 'driven' ? colors.accent : badge.kind === 'unknown' ? colors.warn : colors.tertiary;
  return <Chip tint={tint}>{badge.text}</Chip>;
}
