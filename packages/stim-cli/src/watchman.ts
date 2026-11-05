import { getExecutor } from './exec.ts';

export type WatchmanCommand = (args: string[], timeoutMs: number) => Promise<unknown>;

/** Runs one watchman command with `--no-spawn`, so Stim never starts a daemon, and parses its JSON answer. */
export const runWatchman: WatchmanCommand = async (args, timeoutMs) =>
  JSON.parse(await getExecutor().runFileAsync('watchman', ['--no-spawn', ...args], { timeoutMs }));

export function parseWatchRoots(payload: unknown): string[] | null {
  const roots = (payload as { roots?: unknown } | null)?.roots;
  if (!Array.isArray(roots)) return null;
  return roots.filter((root): root is string => typeof root === 'string');
}

export function parseSubscriberNames(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object' || 'error' in payload) return null;
  const subscribers = (payload as { subscribers?: unknown }).subscribers;
  if (subscribers === undefined) return [];
  if (!Array.isArray(subscribers)) return null;
  const names: string[] = [];
  for (const subscriber of subscribers) {
    const name = (subscriber as { info?: { name?: unknown } } | null)?.info?.name;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  return names;
}

export function parseTriggerCount(payload: unknown): number | null {
  const triggers = (payload as { triggers?: unknown } | null)?.triggers;
  return Array.isArray(triggers) ? triggers.length : null;
}

export function parseWatchmanPid(payload: unknown): number | null {
  const pid = (payload as { pid?: unknown } | null)?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export interface WatchmanClient {
  pid: number;
  name: string | null;
}

/** The connected clients in a `debug-status` answer, or null when the answer does not list them. */
export function parseWatchmanClients(payload: unknown): WatchmanClient[] | null {
  if (!payload || typeof payload !== 'object' || 'error' in payload) return null;
  const clients = (payload as { clients?: unknown }).clients;
  if (!Array.isArray(clients)) return null;
  const parsed: WatchmanClient[] = [];
  for (const client of clients) {
    const peer = (client as { peer?: { pid?: unknown; name?: unknown } } | null)?.peer;
    if (typeof peer?.pid !== 'number') return null;
    parsed.push({ pid: peer.pid, name: typeof peer.name === 'string' ? peer.name : null });
  }
  return parsed;
}
