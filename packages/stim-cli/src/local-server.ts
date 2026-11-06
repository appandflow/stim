import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import type { Methods, WebShareRow } from '@stim-cli/core/protocol';
import { isJsonObject, serverLocalSocket } from '@stim-cli/core/state';
import { canonicalPath } from './commands/gc/paths.ts';
import { pauseShareLinks } from './workspace/share-links.ts';
import { getExecutor } from './exec.ts';
import { pidExists } from './metro.ts';

export type ShareMethod = 'share.start' | 'share.stop' | 'share.list';

type LocalMethod = ShareMethod | 'presence.publish';

export type LocalServerAnswer<M extends LocalMethod> = (
  | { result: Methods[M]['result'] }
  | { error: { code: string; message: string } }
) & {
  /** The TCP port the answering server reports in `hello`, which tells servers of one Stim home apart. */
  serverPort?: number;
};

/** No stim-server answered on this Stim home's local Unix socket. */
export class LocalServerUnavailable extends Error {}

const TIMEOUT_MS = 120_000;
const SHARE_LIST_TIMEOUT_MS = 5000;
const START_WAIT_MS = 60_000;
const SERVER_EXIT_WAIT_MS = 15_000;
const START_POLL_MS = 250;

/**
 * Sends one request to this Stim home's own stim-server over its local Unix socket, after `hello`, and returns the
 * answer. Throws {@link LocalServerUnavailable} when no server listens there.
 */
export async function requestLocalServer<M extends LocalMethod>(
  method: M,
  params: Methods[M]['params'],
  { version, timeoutMs = TIMEOUT_MS }: { version: string; timeoutMs?: number },
): Promise<LocalServerAnswer<M>> {
  const path = serverLocalSocket();
  if (process.platform === 'win32' || !existsSync(path)) {
    throw new LocalServerUnavailable(`no stim-server socket at ${path}`);
  }
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${path}:/`);
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
      finish(() => reject(opened ? error : new LocalServerUnavailable(`${path}: ${error.message}`))),
    );
    socket.on('close', () => finish(() => reject(new Error(`stim-server closed the connection during ${method}.`))));
  });
}

/** What the server on this Stim home's local socket reports in `hello`. */
export interface LocalHello {
  version: string;
  port: number | null;
  features: string[];
}

/** Asks the server on this Stim home's local Unix socket for its `hello`; null when none answers within `timeoutMs`. */
export async function readLocalHello(version: string, timeoutMs: number): Promise<LocalHello | null> {
  const path = serverLocalSocket();
  if (process.platform === 'win32' || !existsSync(path)) return null;
  const { WebSocket } = await import('ws');
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws+unix://${path}:/`);
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
          features: Array.isArray(result.features)
            ? result.features.filter((each: unknown) => typeof each === 'string')
            : [],
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

/** Where a stim-server that `stim share` started holds its ownership claim and writes its log. */
function shareServerPaths(): { claim: string; log: string } {
  const dir = join(configDir(), 'server');
  return { claim: join(dir, 'share-server'), log: join(dir, 'share-server.log') };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port')),
      );
    });
  });
}

export type ShareServerStart =
  | { started: true; pid: number; log: string }
  | { started: false; reason: 'joined' }
  | { started: false; reason: 'failed'; message: string; log: string };

/**
 * Starts a loopback-only stim-server in the background for this Stim home, as `stim serve --share`, and waits until
 * its local socket answers. When another server won the socket meanwhile, it stops its own and reports `joined`.
 */
export async function startShareServer(
  server: { file: string; args: string[] },
  version: string,
): Promise<ShareServerStart> {
  const { log } = shareServerPaths();
  mkdirSync(dirname(log), { recursive: true });
  const port = await freePort();
  const fd = openSync(log, 'a');
  let exited: string | null = null;
  let child;
  try {
    child = getExecutor().spawn(server.file, [...server.args, 'serve', '--share', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref?.();
  child.on?.('error', (error: Error) => {
    exited = error.message;
  });
  child.on?.('exit', (code: number | null, signal: string | null) => {
    exited = `it exited with ${signal ?? `code ${code}`}`;
  });
  const pid = child.pid;
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    try {
      const answer = await requestLocalServer('share.list', {}, { version, timeoutMs: 5000 });
      if (answer.serverPort === port && pid !== undefined) return { started: true, pid, log };
      if (exited === null && pid !== undefined) process.kill(pid, 'SIGTERM');
      return { started: false, reason: 'joined' };
    } catch (cause) {
      if (!(cause instanceof LocalServerUnavailable) && exited !== null) break;
    }
    if (exited !== null) break;
  }
  if (exited === null && pid !== undefined) process.kill(pid, 'SIGTERM');
  return {
    started: false,
    reason: 'failed',
    message: exited ? `stim-server did not start: ${exited}.` : 'stim-server did not answer within 60 s.',
    log,
  };
}

/** The stim-server `stim share` started: asked to stop (`exited` once it has), or left running for `starting` share starts. */
export type ShareServerStop = { pid: number; exited: boolean } | { pid: number; starting: number };

/**
 * Stops the stim-server `stim share` started for this Stim home, when it holds no share and answers no share start.
 * A server started any other way (Stim Desktop, the LaunchAgent, by hand) holds no such claim and is never stopped. A
 * server with a start in flight keeps running and exits by itself if that start leaves no share. Returns its pid and
 * whether it exited, after waiting up to 15 seconds, so a share started next does not meet a server that is stopping.
 * A server before `share-starting` reports no starts, so one in flight there is not seen.
 */
export async function stopIdleShareServer(version: string): Promise<ShareServerStop | null> {
  const holder = readClaimSet(shareServerPaths().claim).live[0];
  if (!holder) return null;
  let starting = 0;
  try {
    const answer = await requestLocalServer('share.list', {}, { version, timeoutMs: 5000 });
    if (answer.serverPort !== holder.details.port || !('result' in answer) || answer.result.shares.length) return null;
    starting = answer.result.starting ?? 0;
  } catch {
    return null;
  }
  if (starting > 0) return { pid: holder.owner.pid, starting };
  process.kill(holder.owner.pid, 'SIGTERM');
  const deadline = Date.now() + SERVER_EXIT_WAIT_MS;
  while (pidExists(holder.owner.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { pid: holder.owner.pid, exited: !pidExists(holder.owner.pid) };
}
