import { useEffect, useState } from 'react';

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
  const [state, setState] = useState<MachineDetailsState>({ kind: 'loading' });
  useEffect(() => {
    if (!connection || !active) return;
    let cancelled = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSince: number | null = null;
    const ask = () =>
      connection.request('machine.details', {}).then(
        (details) => {
          if (cancelled) return;
          setState({ kind: 'ready', details });
          if (!details.buildMachinesPending) {
            pendingSince = null;
            return;
          }
          if (pendingSince === null) pendingSince = Date.now();
          if (Date.now() - pendingSince < PENDING_POLL_MAX_MS) {
            pendingTimer = setTimeout(() => void ask(), PENDING_POLL_MS);
          }
        },
        (error: unknown) => {
          if (cancelled) return;
          if (error instanceof RequestError && error.error.code === 'unknown-method') {
            return setState({ kind: 'unsupported' });
          }
          const message = error instanceof Error ? error.message : String(error);
          setState((current) => (current.kind === 'ready' ? current : { kind: 'failed', message }));
        },
      );
    void ask();
    const timer = setInterval(() => void ask(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, [connection, active]);
  return state;
}
