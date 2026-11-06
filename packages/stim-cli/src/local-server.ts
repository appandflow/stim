import type { Methods, WebShareRow } from '@stim-cli/core/protocol';
import { isJsonObject } from '@stim-cli/core/state';
import { canonicalPath } from './commands/gc/paths.ts';
import { connectNet } from './daemon/client.ts';
import { pauseShareLinks } from './workspace/share-links.ts';

export type ShareMethod = 'share.start' | 'share.stop' | 'share.list';

type LocalMethod = ShareMethod;

export type LocalServerAnswer<M extends LocalMethod> = (
  | { result: Methods[M]['result'] }
  | { error: { code: string; message: string } }
) & {
  /** The TCP port the answering server reports in `hello`, which tells servers of one Stim home apart. */
  serverPort?: number;
};

/** No net thread answered through this Stim home's stimd. */
export class LocalServerUnavailable extends Error {}

const TIMEOUT_MS = 120_000;
const SHARE_LIST_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;

/** A WebSocket to this home's net thread over stimd's CLI socket, or null when none answers within `timeoutMs`. */
async function openLocal(timeoutMs: number) {
  const socket = await connectNet(Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
  if (!socket) return null;
  const { WebSocket } = await import('ws');
  return new WebSocket('ws://localhost/', { createConnection: () => socket });
}

/**
 * Sends one request to this Stim home's net thread through stimd's CLI socket, after `hello`, and returns the answer.
 * Throws {@link LocalServerUnavailable} when no net thread runs.
 */
export async function requestLocalServer<M extends LocalMethod>(
  method: M,
  params: Methods[M]['params'],
  { version, timeoutMs = TIMEOUT_MS }: { version: string; timeoutMs?: number },
): Promise<LocalServerAnswer<M>> {
  const socket = await openLocal(timeoutMs);
  if (!socket) throw new LocalServerUnavailable('stimd runs no net thread for this Stim home');
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let serverPort: number | undefined;
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
        if (error) return finish(() => resolve({ error }));
        const port = isJsonObject(result) && isJsonObject(result.server) ? result.server.port : undefined;
        if (typeof port === 'number') serverPort = port;
        socket.send(JSON.stringify({ id: 2, method, params }));
      } else if (id === 2) {
        finish(() =>
          resolve({ ...(error ? { error } : { result }), ...(serverPort !== undefined ? { serverPort } : {}) }),
        );
      }
    });
    socket.on('error', (error) =>
      finish(() => reject(opened ? error : new LocalServerUnavailable(error.message))),
    );
    socket.on('close', () => finish(() => reject(new Error(`stim-server closed the connection during ${method}.`))));
  });
}

/** What this Stim home's net thread reports in `hello`. */
export interface LocalHello {
  version: string;
  port: number | null;
  /** The server's Stim Desktop integer; 0 from a server before it had one. */
  desktopApi: number;
}

/** Asks this Stim home's net thread for its `hello`; null when none answers within `timeoutMs`. */
export async function readLocalHello(version: string, timeoutMs: number): Promise<LocalHello | null> {
  const socket = await openLocal(timeoutMs);
  if (!socket) return null;
  return new Promise((resolve) => {
    const finish = (hello: LocalHello | null) => {
      clearTimeout(timer);
      socket.terminate();
      resolve(hello);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('open', () =>
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: { client: { name: 'stim', version } } })),
    );
    socket.on('message', (data) => {
      try {
        const { result } = JSON.parse(data.toString()) ?? {};
        const server = isJsonObject(result) && isJsonObject(result.server) ? result.server : null;
        if (!server || typeof server.version !== 'string') return finish(null);
        finish({
          version: server.version,
          port: typeof server.port === 'number' ? server.port : null,
          desktopApi: typeof result.desktopApi === 'number' ? result.desktopApi : 0,
        });
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/**
 * Ends the web shares of `workspace`, or of its `slot` alone, in this Stim home's stim-server. A share waits for its
 * device when the device goes away on its own, so stopping a workspace or slot ends its shares explicitly. Best effort:
 * a missing or silent server has no share to end.
 */
export async function endWorkspaceShares(workspace: string, slot?: string): Promise<void> {
  try {
    pauseShareLinks(workspace, slot);
  } catch {}
  try {
    await requestLocalServer(
      'share.stop',
      { workspace, ...(slot === undefined ? {} : { slot }) },
      { version: 'stim', timeoutMs: 3000 },
    );
  } catch {}
}

/**
 * This Stim home's web shares. Null when no stim-server runs, or the one that answers has no `share.list` (a server
 * before 1.39): a share lives only in its server's memory, so neither can hold one. `unreadable` when a running server
 * cannot give the list.
 */
export type WebShareList = WebShareRow[] | null | { unreadable: string };

/** Lists this Stim home's web shares through its stim-server's `share.list`. */
export async function readWebShares(): Promise<WebShareList> {
  let answer: LocalServerAnswer<'share.list'>;
  try {
    answer = await requestLocalServer('share.list', {}, { version: 'stim', timeoutMs: SHARE_LIST_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof LocalServerUnavailable) return null;
    return { unreadable: (error instanceof Error ? error.message : String(error)).replace(/\.+$/, '') };
  }
  if ('error' in answer)
    return answer.error.code === 'unknown-method' ? null : { unreadable: answer.error.message.replace(/\.+$/, '') };
  const shares = answer.result?.shares;
  return Array.isArray(shares) ? shares : { unreadable: 'stim-server sent no share list' };
}

/**
 * Why `shares` keep `workspace` out of the idle stage, the pressure ladder, the dormant stage, the admission reclaim
 * and finished-worktree device deletion: each of its shares that has not ended or passed its expiry, or a list that
 * cannot be read. Null when none is live.
 */
export function shareKeepReason(shares: WebShareList, workspace: string, now: number = Date.now()): string | null {
  if (shares === null) return null;
  if (!Array.isArray(shares)) return `its web shares cannot be listed (${shares.unreadable})`;
  const self = canonicalPath(workspace);
  const live = shares.filter(
    (share) => canonicalPath(share.workspace) === self && !(Date.parse(share.expiresAt) <= now),
  );
  if (!live.length) return null;
  const targets = live.map(
    (share) =>
      `${share.platform}${share.physical ? ' device' : ''}${share.slot === 'default' ? '' : ` slot ${share.slot}`} until ${share.expiresAt}`,
  );
  return live.length === 1
    ? `it has a live web share (${targets[0]}); stim share stop ends it`
    : `it has live web shares (${targets.join(', ')}); stim share stop ends them`;
}

export async function liveShareKeepReason(workspace: string, now: number = Date.now()): Promise<string | null> {
  return shareKeepReason(await readWebShares(), workspace, now);
}
