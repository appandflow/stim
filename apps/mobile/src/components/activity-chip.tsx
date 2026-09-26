import { Pill } from '@/components/pill';
import { useNow } from '@/hooks/use-now';
import { activityBadge } from '@/lib/format';
import type { DeviceActivity } from '@/protocol/types';

export function ActivityChip({ activity, frozenAt }: { activity?: DeviceActivity; frozenAt?: number | null }) {
  const ticking = useNow(30_000);
  const badge = activityBadge(activity, frozenAt ?? ticking);
  if (!badge) return null;
  return <Pill tone={badge.kind === 'driven' ? 'accent' : 'neutral'}>{badge.text}</Pill>;
}
