import { useEffect, useRef } from 'react';

import { usePolledRequest } from '@/hooks/polled-request';
import { RequestError, type StimConnection } from '@/lib/connection';
import type { MachineDetails } from '@/protocol/types';

export type MachineDetailsState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: MachineDetails }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

const REFRESH_MS = 60_000;
const PENDING_POLL_MS = 2_000;
const PENDING_POLL_MAX_MS = 30_000;

interface Pending {
  since: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function schedulePending(details: MachineDetails, pending: Pending, refetch: () => void): void {
  if (pending.timer) clearTimeout(pending.timer);
  if (!details.buildMachinesPending) {
    pending.since = null;
    return;
  }
  if (pending.since === null) pending.since = Date.now();
  if (Date.now() - pending.since < PENDING_POLL_MAX_MS) pending.timer = setTimeout(refetch, PENDING_POLL_MS);
}

/**
 * The Mac's `machine.details`, asked when `active` turns on and each minute while it stays on; the server
 * shares one result per minute, so asking more often gets nothing newer. A server that predates it answers
 * `unknown-method`, and the screen hides what needs it. A failed refresh keeps the last result.
 *
 * The server never waits for `stim doctor` to answer: a reply with `buildMachinesPending` carries whatever
 * build-machine result it has cached (possibly none yet) while a refresh runs in the background. While that
 * flag is set, this hook re-asks every `PENDING_POLL_MS` for up to `PENDING_POLL_MAX_MS` instead of waiting for
 * the next minute, so the Build Machines section fills in shortly after the rest of the screen renders.
 */
export function useMachineDetails(connection: StimConnection | null, active: boolean): MachineDetailsState {
  const pending = useRef<Pending>({ since: null, timer: null });
  const { data, error, refetch } = usePolledRequest(
    connection,
    'machine.details',
    {},
    {
      intervalMs: REFRESH_MS,
      active,
      onData: (details) => schedulePending(details, pending.current, refetch),
    },
  );

  useEffect(
    () => () => {
      pending.current.since = null;
      if (pending.current.timer) clearTimeout(pending.current.timer);
    },
    [connection, active],
  );

  if (error instanceof RequestError && error.error.code === 'unknown-method') return { kind: 'unsupported' };
  if (data) return { kind: 'ready', details: data };
  if (error) return { kind: 'failed', message: error.message };
  return { kind: 'loading' };
}
