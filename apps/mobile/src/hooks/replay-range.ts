import { useMacConnection } from '@/hooks/machines';
import { usePolledRequest } from '@/hooks/polled-request';
import type { Methods, ReplayRange } from '@/protocol/types';

const POLL_MS = 10_000;

export function useReplayRangeState(target: Methods['replay.range']['params'], enabled = true) {
  const { connection, state } = useMacConnection();
  return usePolledRequest(connection, 'replay.range', target, {
    intervalMs: target.archive ? undefined : POLL_MS,
    active: enabled && state.kind === 'open' && target.platform !== 'macos',
  });
}

export function useReplayRange(target: Methods['replay.range']['params']): ReplayRange | null {
  return useReplayRangeState(target).data;
}
