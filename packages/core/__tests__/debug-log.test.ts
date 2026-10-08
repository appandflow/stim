import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDebugLog, debugLogDir, debugLoggingEnabled } from '../state/debug-log.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-debug-log-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const records = (component: string) =>
  readFileSync(join(debugLogDir(), `${component}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('writes nothing unless STIM_DEBUG or the debug.logs setting is on', () => {
  const log = createDebugLog('cli', { env: {} });
  log.log('run_start');
  expect(existsSync(debugLogDir())).toBe(false);
  const on = createDebugLog('cli', { env: { STIM_DEBUG: '1' } });
  on.log('run_start', { command: ['ios'] });
  expect(records('cli')).toMatchObject([{ src: 'cli', level: 'debug', event: 'run_start', command: ['ios'] }]);
});

test('STIM_DEBUG overrides the machine setting in both directions', () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ debug: { logs: true } }));
  expect(debugLoggingEnabled({})).toBe(true);
  expect(debugLoggingEnabled({ STIM_DEBUG: '0' })).toBe(false);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ debug: { logs: false } }));
  expect(debugLoggingEnabled({})).toBe(false);
  expect(debugLoggingEnabled({ STIM_DEBUG: 'true' })).toBe(true);
  expect(debugLoggingEnabled({ STIM_DEBUG: 'yes' })).toBe(false);
  expect(debugLoggingEnabled({ STIM_DEBUG: 'TRUE' })).toBe(false);
});

test('a long-running process follows a setting changed after it started', () => {
  let clock = 0;
  const log = createDebugLog('server', { env: {}, now: () => clock });
  expect(log.enabled()).toBe(false);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ debug: { logs: true } }));
  expect(log.enabled()).toBe(false);
  clock += 6000;
  expect(log.enabled()).toBe(true);
});

test('redacts keys that name a secret, at any depth', () => {
  const log = createDebugLog('server', { env: { STIM_DEBUG: '1' } });
  log.log('request', { method: 'hello', auth: { deviceToken: 'abc123' }, ticket: 'xyz', peer: 'mac-mini' });
  const [record] = records('server');
  expect(JSON.stringify(record)).not.toMatch(/abc123|xyz/);
  expect(record).toMatchObject({ auth: { deviceToken: '[redacted]' }, ticket: '[redacted]', peer: 'mac-mini' });
});
