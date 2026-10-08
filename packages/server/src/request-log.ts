import { createDebugLog, type DebugLog } from '@stim-cli/core/state';

const SLOW_MS = 1000;
const ERROR_REPEAT_MS = 60_000;
const MAX_REMEMBERED = 256;

type Id = string | number | null;

export interface RequestTracker {
  /** The connection's client, once hello names it: the paired device id and the CLI run id, never a token. */
  identify(client: { id: string | null; runId: string | null }): void;
  begin(id: Id, method: string): void;
  step(id: Id, name: string, ms: number): void;
  /** Sees every message the server sends on the connection; a reply to a tracked request ends it. */
  reply(message: unknown): void;
}

export interface RequestLog {
  track(): RequestTracker;
  /** A host-leg event (connect, hello, failure) of the hosted relay. */
  host(event: string, fields: Record<string, unknown>, failed?: boolean): void;
}

const text = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

/**
 * Request timing for stim-server. An error reply always goes to the service log (stderr), once a minute per
 * client, method and code. With debug logging on, every request goes to the service log and to
 * `logs/debug/server.ndjson` with its duration and the slow steps. Lines carry the method, the client's device id,
 * the CLI run id, durations and the error code: never params, messages, tokens or tickets.
 */
export function createRequestLog({
  service = (line: string) => console.error(line),
  debug = createDebugLog('server'),
  now = Date.now,
}: { service?: (line: string) => void; debug?: DebugLog; now?: () => number } = {}): RequestLog {
  const lastError = new Map<string, number>();
  const errorDue = (key: string): boolean => {
    const at = now();
    const last = lastError.get(key);
    if (last !== undefined && at - last < ERROR_REPEAT_MS) return false;
    lastError.delete(key);
    lastError.set(key, at);
    if (lastError.size > MAX_REMEMBERED) lastError.delete(lastError.keys().next().value!);
    return true;
  };
  return {
    track() {
      let client: { id: string | null; runId: string | null } = { id: null, runId: null };
      const inflight = new Map<Id, { method: string; start: number; steps: Record<string, number> }>();
      return {
        identify(next) {
          client = next;
        },
        begin(id, method) {
          if (id === null) return;
          if (inflight.size >= MAX_REMEMBERED) inflight.delete(inflight.keys().next().value!);
          inflight.set(id, { method, start: now(), steps: {} });
        },
        step(id, name, ms) {
          const entry = inflight.get(id);
          if (entry) entry.steps[name] = Math.round(ms);
        },
        reply(message) {
          if (!message || typeof message !== 'object' || !('id' in message)) return;
          const { id, error } = message as { id: Id; error?: { code?: unknown } };
          const entry = inflight.get(id);
          if (entry) inflight.delete(id);
          if (!entry && !error) return;
          const code = error ? String(error.code ?? 'error').slice(0, 64) : undefined;
          const method = entry?.method ?? 'unknown';
          const ms = entry ? now() - entry.start : undefined;
          const fields = {
            method,
            client: client.id ?? undefined,
            run: client.runId ?? undefined,
            ms,
            ...(ms !== undefined && ms >= SLOW_MS ? { slow: true } : {}),
            ...entry?.steps,
            error: code,
          };
          if (debug.enabled()) {
            service(`stim-server: debug request ${text(fields)}`);
            const { run, ...rest } = fields;
            debug.log('request', { ...rest, runId: run });
          } else if (code !== undefined && errorDue(`${client.id}|${method}|${code}`)) {
            service(`stim-server: request failed ${text(fields)}`);
          }
        },
      };
    },
    host(event, fields, failed = false) {
      if (debug.enabled()) {
        service(`stim-server: debug ${event} ${text(fields)}`);
        debug.log(event, fields);
      } else if (failed && errorDue(`host|${event}|${String(fields.host)}`)) {
        service(`stim-server: ${event} ${text(fields)}`);
      }
    },
  };
}
