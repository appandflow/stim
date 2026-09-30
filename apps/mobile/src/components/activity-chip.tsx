import { Pill } from '@/components/pill';
import { useNow } from '@/hooks/use-now';
import { activityBadge } from '@/lib/format';
import type { DeviceActivity } from '@/protocol/types';

export function ActivityChip({ activity }: { activity?: DeviceActivity }) {
  const now = useNow(30_000);
  const badge = activityBadge(activity, now);
  if (!badge) return null;
  return <Pill tone={badge.kind === 'driven' ? 'accent' : 'neutral'}>{badge.text}</Pill>;
}
