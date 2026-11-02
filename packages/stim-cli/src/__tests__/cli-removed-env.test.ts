import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-removed-env-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, STIM_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });

test('a command the daemon governs refuses while STIM_MAINTENANCE is set, naming STIM_DAEMON', () => {
  const refused = run(['gc', '--json'], { STIM_MAINTENANCE: 'off' });
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stdout)).toEqual({
    code: 'STIM_BAD_ARG',
    message: expect.stringContaining('STIM_MAINTENANCE (maintenance.mode) was removed; use STIM_DAEMON'),
    remedy: expect.stringContaining('Unset STIM_MAINTENANCE'),
  });
  expect(refused.stderr).toContain('STIM_BAD_ARG: STIM_MAINTENANCE (maintenance.mode) was removed');
});

test('a command the daemon does not govern still runs with a removed variable set', () => {
  const read = run(['settings', 'get', 'daemon.mode'], { STIM_MAINTENANCE: 'off', STIM_DAEMON: 'report' });
  expect(read.status).toBe(0);
  expect(read.stdout.trim()).toBe('report');
});
