import { useEffect, useState } from 'react';

import { useMacConnection } from '@/hooks/mac-connection';
import { RequestError } from '@/lib/connection';
import type { DevicePlatform, ReplayRange } from '@/protocol/types';

const POLL_MS = 10_000;

/**
 * What the Mac recorded of a device slot, polled while the viewer is open so the timeline grows with the
 * recording. An answer older than one already shown is dropped. Null until the first answer, and from a server
 * without replay.
 */
export function useReplayRange(target: {
  workspace: string;
  platform: DevicePlatform;
  slot: string;
}): ReplayRange | null {
  const { connection, state } = useMacConnection();
  const open = state.kind === 'open';
  const { workspace, platform, slot } = target;
  const [range, setRange] = useState<{ key: string; range: ReplayRange } | null>(null);
  const key = `${workspace}\n${platform}\n${slot}`;
  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    const order = { sent: 0, shown: 0 };
    const poll = () => {
      order.sent += 1;
      const sequence = order.sent;
      return connection.request('replay.range', { workspace, platform, slot }).then(
        (result) => {
          if (cancelled || sequence < order.shown) return;
          order.shown = sequence;
          setRange({ key, range: result });
        },
        (error: Error) => {
          if (error instanceof RequestError && error.error.code === 'unknown-method') clearInterval(timer);
        },
      );
    };
    const timer = setInterval(poll, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, open, key, workspace, platform, slot]);
  return range && range.key === key ? range.range : null;
}
