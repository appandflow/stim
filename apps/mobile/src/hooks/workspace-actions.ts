import { t } from '@lingui/core/macro';
import { useCallback, useState } from 'react';

import { RequestError } from '@/lib/connection';
import type { ActionName, ActionParams, ReloadPlatform } from '@/protocol/types';

import { useMacConnection } from './machines';

export interface WorkspaceActions {
  /** The actions this Mac lets this phone run: empty for a read-only pairing, null while not connected or from a server that predates actions. */
  available: ActionName[] | null;
  pending: ActionName | null;
  /** Resolves null when the action succeeded, and the error message when it failed. */
  run: (action: ActionName, options?: { platform?: ReloadPlatform }) => Promise<string | null>;
}

export function useAction(workspace: string): WorkspaceActions {
  const { connection, state } = useMacConnection();
  const [pending, setPending] = useState<ActionName | null>(null);
  const run = useCallback(
    async (action: ActionName, options: { platform?: ReloadPlatform } = {}) => {
      if (!connection) return t`Not connected.`;
      const params: ActionParams =
        action === 'reload'
          ? { action, workspace, ...(options.platform ? { platform: options.platform } : {}) }
          : { action, workspace };
      setPending(action);
      let error: string | null = null;
      try {
        await connection.request('action', params);
      } catch (cause) {
        if (cause instanceof RequestError && cause.error.code === 'forbidden') connection.reconnect();
        error = (cause as Error).message;
      }
      setPending(null);
      return error;
    },
    [connection, workspace],
  );
  return { available: state.kind === 'open' ? state.actions : null, pending, run };
}
