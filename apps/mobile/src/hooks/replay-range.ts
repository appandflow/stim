import { useMacConnection } from '@/hooks/machines';
import { usePolledRequest } from '@/hooks/polled-request';
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
  const { data } = usePolledRequest(
    connection,
    'replay.range',
    { workspace, platform, slot },
    {
      intervalMs: POLL_MS,
      active: open && platform !== 'macos',
    },
  );
  return data;
}
