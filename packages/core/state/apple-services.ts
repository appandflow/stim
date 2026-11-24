import { closeSync, fstatSync, openSync, readSync, readFileSync } from 'node:fs';
import { isJsonObject } from './json-file.ts';

export type HelperState =
  | 'registered'
  | 'requires approval'
  | 'not registered'
  | 'unavailable on this OS'
  | 'Stim Host missing'
  | 'Stim Host too old'
  | 'status timed out'
  | 'status error';

export interface HelperHeartbeat {
  at: number;
  ok: boolean;
  error?: string;
}

export function readHelperHeartbeat(): HelperHeartbeat | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync('/Library/Logs/Stim/helper.heartbeat', 'utf8'));
    if (!isJsonObject(value) || typeof value.at !== 'number' || typeof value.ok !== 'boolean') return undefined;
    return {
      at: value.at * 1000,
      ok: value.ok,
      ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
    };
  } catch {
    return undefined;
  }
}

export function helperHealthy(heartbeat: HelperHeartbeat | undefined, now: number = Date.now()): boolean {
  return Boolean(heartbeat?.ok && heartbeat.at - now <= 60_000 && now - heartbeat.at < 180_000);
}

export interface AppleServiceRestart {
  at: number;
  name: string;
  pid: number;
  cpu: number;
  rss: number;
  seconds: number;
}

export interface AppleServicesStatus {
  helper: HelperState;
  heartbeat?: HelperHeartbeat;
  warnings: { name: string; pid: number; cpu: number; rss: number; commands: string[] }[];
  restarts: AppleServiceRestart[];
}

/** Successful SIGTERM deliveries in the current and rotated log tails, within the last hour. */
export function readHelperRestarts(now: number = Date.now()): AppleServiceRestart[] {
  const restarts: AppleServiceRestart[] = [];
  for (const path of ['/Library/Logs/Stim/helper.ndjson.1', '/Library/Logs/Stim/helper.ndjson']) {
    let text: string;
    try {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - 256 * 1024);
        const tail = Buffer.alloc(Math.min(size, 256 * 1024));
        const bytes = readSync(fd, tail, 0, tail.length, start);
        text = tail.subarray(0, bytes).toString('utf8');
        if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"event":"result"')) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (
          !isJsonObject(value) ||
          value.event !== 'result' ||
          value.error !== 0 ||
          typeof value.at !== 'number' ||
          value.at * 1000 < now - 3600_000 ||
          value.at * 1000 > now ||
          typeof value.name !== 'string' ||
          typeof value.pid !== 'number' ||
          typeof value.cpu !== 'number' ||
          typeof value.rss !== 'number' ||
          typeof value.seconds !== 'number'
        )
          continue;
        restarts.push({
          at: value.at * 1000,
          name: value.name,
          pid: value.pid,
          cpu: value.cpu,
          rss: value.rss,
          seconds: value.seconds,
        });
      } catch {}
    }
  }
  return restarts;
}
