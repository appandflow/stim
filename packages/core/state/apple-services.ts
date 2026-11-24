import { readFileSync } from 'node:fs';
import { isJsonObject } from './json-file.ts';

export type HelperState = 'registered' | 'requires approval' | 'not registered' | 'unavailable on this OS';

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
  warnings: { name: string; pid: number; cpu: number; rss: number; commands: string[] }[];
  restarts: AppleServiceRestart[];
}

/** Successful SIGTERM deliveries in the helper's current and rotated log, within the last hour. */
export function readHelperRestarts(now: number = Date.now()): AppleServiceRestart[] {
  const restarts: AppleServiceRestart[] = [];
  for (const path of ['/Library/Logs/Stim/helper.ndjson.1', '/Library/Logs/Stim/helper.ndjson']) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
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
