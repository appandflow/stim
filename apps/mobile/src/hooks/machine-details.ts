import { useEffect, useState } from 'react';

import { RequestError, type StimConnection } from '@/lib/connection';
import type { MachineDetails } from '@/protocol/types';

export type MachineDetailsState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: MachineDetails }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

/**
 * The Mac's `machine.details`, asked once each time the connection opens. A server that predates it answers
 * `unknown-method`, and the screen hides what needs it.
 */
export function useMachineDetails(connection: StimConnection | null, open: boolean): MachineDetailsState {
  const [state, setState] = useState<MachineDetailsState>({ kind: 'loading' });
  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    connection.request('machine.details', {}).then(
      (details) => !cancelled && setState({ kind: 'ready', details }),
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof RequestError && error.error.code === 'unknown-method') setState({ kind: 'unsupported' });
        else setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open]);
  return state;
}
