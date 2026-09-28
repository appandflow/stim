import { useEffect, useState } from 'react';

import { useMacConnection } from '@/hooks/mac-connection';
import { RequestError } from '@/lib/connection';
import type { DevicePlatform, ReplayRange } from '@/protocol/types';

/** A range as the Mac answered it, and when: a device still recorded has footage up to about then. */
export interface ReplayRangeAnswer extends ReplayRange {
  answeredAt: number;
}

const POLL_MS = 10_000;

/**
 * What the Mac recorded of a device slot, polled while the viewer is open so the timeline grows with the
 * recording. Null until the first answer, and from a server without replay.
 */
export function useReplayRange(target: {
  workspace: string;
  platform: DevicePlatform;
  slot: string;
}): ReplayRangeAnswer | null {
  const { connection, state } = useMacConnection();
  const open = state.kind === 'open';
  const { workspace, platform, slot } = target;
  const [range, setRange] = useState<{ key: string; range: ReplayRangeAnswer } | null>(null);
  const key = `${workspace}\n${platform}\n${slot}`;
  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    const poll = () =>
      connection.request('replay.range', { workspace, platform, slot }).then(
        (result) => !cancelled && setRange({ key, range: { ...result, answeredAt: Date.now() } }),
        (error: Error) => {
          if (error instanceof RequestError && error.error.code === 'unknown-method') clearInterval(timer);
        },
      );
    const timer = setInterval(poll, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, open, key, workspace, platform, slot]);
  return range && range.key === key ? range.range : null;
}
