import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { launchStimd } from '../daemon/client.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-launchd-guard-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function recordCalls(launchctl: string) {
  const calls: string[] = [];
  const child = { once: () => child, on: () => child, unref: () => {} };
  setExecutor({
    findExecutable: (name: string) => (name === 'launchctl' ? launchctl : null),
    runFile: (file: string, args: string[]) => {
      calls.push(`${file} ${args[0]}`);
      return '';
    },
    spawn: () => {
      calls.push('spawn');
      return child;
    },
  });
  return calls;
}

test('the test guard starts stimd as a detached process instead of through the real launchctl', () => {
  const calls = recordCalls('/bin/launchctl');
  launchStimd({}, 'on', 'darwin', '/entry.mjs');
  expect(calls).toEqual(['spawn']);
});

test('the test guard still lets a stub launchctl on PATH start the job', () => {
  const calls = recordCalls('/stub/bin/launchctl');
  launchStimd({}, 'on', 'darwin', '/entry.mjs');
  expect(calls).toEqual(['launchctl bootstrap']);
});
