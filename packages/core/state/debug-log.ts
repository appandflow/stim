import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, configDir, rotateLog } from '../index.ts';
import { loadConfig } from './config.ts';
import { coerceSettingText, settingDefinition, settingValueError } from './settings-registry.ts';

export const DEBUG_ENV = 'STIM_DEBUG';

const ENABLED_RECHECK_MS = 5000;
const ROTATE_CHECK_BYTES = 256 * 1024;
const SECRET_KEY = /token|secret|ticket|password|passphrase|authorization|credential|cookie|apikey/i;
const MAX_DEPTH = 4;

export function debugLogDir(): string {
  return join(configDir(), 'logs', 'debug');
}

/** The `STIM_DEBUG` override (1/true on, 0/false off, anything else off), else the machine setting `debug.logs`. Never throws. */
export function debugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const definition = settingDefinition('debug.logs')!;
  const raw = env[DEBUG_ENV];
  if (raw !== undefined && raw !== '') {
    const value = coerceSettingText(definition, raw);
    return settingValueError(definition, value) === null && value === true;
  }
  try {
    return loadConfig()?.debug?.logs === true;
  } catch {
    return false;
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((each) => scrub(each, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, each] of Object.entries(value))
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrub(each, depth + 1);
    return out;
  }
  return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

export interface DebugLog {
  /** Whether debug logging is on right now; re-read every few seconds so a long-running process follows the setting. */
  enabled(): boolean;
  /** Appends one record to `$STIM_HOME/logs/debug/<component>.ndjson` when enabled. Never throws; keys that look like secrets are redacted. */
  log(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Debug-level records for one component (`cli` or `server`). Off by default; `STIM_DEBUG=1` or `debug.logs` turns it
 * on. Callers pass names, durations and codes, never arguments, environment values, tokens or tickets.
 */
export function createDebugLog(
  component: 'cli' | 'server',
  {
    env = process.env,
    now = Date.now,
    base = () => ({}),
  }: { env?: NodeJS.ProcessEnv; now?: () => number; base?: () => Record<string, unknown> } = {},
): DebugLog {
  let checkedAt = Number.NEGATIVE_INFINITY;
  let on = false;
  let unchecked = ROTATE_CHECK_BYTES;
  const enabled = (): boolean => {
    const at = now();
    if (at - checkedAt >= ENABLED_RECHECK_MS) {
      checkedAt = at;
      on = debugLoggingEnabled(env);
    }
    return on;
  };
  return {
    enabled,
    log(event, fields = {}) {
      if (!enabled()) return;
      try {
        const file = join(debugLogDir(), `${component}.ndjson`);
        const line = `${JSON.stringify({ ts: now(), level: 'debug', src: component, event, pid: process.pid, ...base(), ...(scrub(fields) as object) })}\n`;
        mkdirSync(debugLogDir(), { recursive: true });
        if (unchecked >= ROTATE_CHECK_BYTES) {
          unchecked = 0;
          rotateLog(file, LOG_ROTATE_BYTES);
        }
        appendFileSync(file, line, { mode: 0o600 });
        unchecked += line.length;
      } catch {}
    },
  };
}
