import { useEffect, useState } from 'react';

import { RequestError, type StimConnection } from '@/lib/connection';
import type { MachineDetails } from '@/protocol/types';

export type MachineDetailsState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: MachineDetails }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

const REFRESH_MS = 60_000;

/**
 * The Mac's `machine.details`, asked when the connection opens and each minute while it stays open; the server
 * shares one result per minute, so asking more often gets nothing newer. A server that predates it answers
 * `unknown-method`, and the screen hides what needs it. A failed refresh keeps the last result.
 */
export function useMachineDetails(connection: StimConnection | null, open: boolean): MachineDetailsState {
  const [state, setState] = useState<MachineDetailsState>({ kind: 'loading' });
  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    const ask = () =>
      connection.request('machine.details', {}).then(
        (details) => !cancelled && setState({ kind: 'ready', details }),
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
    };
  }, [connection, open]);
  return state;
}
