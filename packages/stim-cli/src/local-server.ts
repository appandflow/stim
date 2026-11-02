import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { Methods } from '@stim-cli/core/protocol';
import { serverLocalSocket } from '@stim-cli/core/state';

export type ShareMethod = 'share.start' | 'share.stop' | 'share.list';

export type LocalServerAnswer<M extends ShareMethod> =
  | { result: Methods[M]['result'] }
  | { error: { code: string; message: string } };

/** No stim-server answered on this Stim home's local Unix socket. */
export class LocalServerUnavailable extends Error {}

const TIMEOUT_MS = 90_000;

/**
 * Sends one request to this Stim home's own stim-server over its local Unix socket, after `hello`, and returns the
 * answer. Throws {@link LocalServerUnavailable} when no server listens there.
 */
export function requestLocalServer<M extends ShareMethod>(
  method: M,
  params: Methods[M]['params'],
  { version, timeoutMs = TIMEOUT_MS }: { version: string; timeoutMs?: number },
): Promise<LocalServerAnswer<M>> {
  const path = serverLocalSocket();
  if (process.platform === 'win32' || !existsSync(path)) {
    return Promise.reject(new LocalServerUnavailable(`no stim-server socket at ${path}`));
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${path}:/`);
    let opened = false;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`stim-server did not answer ${method} within ${timeoutMs / 1000} s.`))),
      timeoutMs,
    );
    socket.on('open', () => {
      opened = true;
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: { client: { name: 'stim', version } } }));
    });
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const { id, result, error } = message ?? {};
      if (id === 1) {
        if (error) finish(() => resolve({ error }));
        else socket.send(JSON.stringify({ id: 2, method, params }));
      } else if (id === 2) {
        finish(() => resolve(error ? { error } : { result }));
      }
    });
    socket.on('error', (error) =>
      finish(() => reject(opened ? error : new LocalServerUnavailable(`${path}: ${error.message}`))),
    );
    socket.on('close', () => finish(() => reject(new Error(`stim-server closed the connection during ${method}.`))));
  });
}

/**
 * Ends the web shares of `workspace` in this Stim home's stim-server. Best effort: a missing or silent server has no
 * share to end, and a share whose device stops ends on its own.
 */
export async function endWorkspaceShares(workspace: string): Promise<void> {
  try {
    await requestLocalServer('share.stop', { workspace }, { version: 'stim', timeoutMs: 3000 });
  } catch {}
}
