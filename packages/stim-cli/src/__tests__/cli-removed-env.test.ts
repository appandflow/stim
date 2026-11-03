import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const run = (args: string[], env: NodeJS.ProcessEnv, cwd?: string) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
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

test.each([
  ['maintenance.mode off', { maintenance: { mode: 'off' } }, 'stim settings set daemon.mode off', 'maintenance.mode'],
  [
    'maintenance.mode report',
    { maintenance: { mode: 'report' } },
    'stim settings set daemon.mode report',
    'maintenance.mode',
  ],
  [
    'devices.idleShutdownMinutes 0',
    { devices: { idleShutdownMinutes: 0 } },
    'stim settings set idle.minutes 0 --scope machine',
    'devices.idleShutdownMinutes',
  ],
])(
  'a governed command refuses while the machine config holds %s, naming the commands that migrate it',
  (_, machine, set, unset) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 2, projects: {}, repos: {}, ...machine }));
    const refused = run(['gc', '--json'], { STIM_DAEMON: '' });
    expect(refused.status).toBe(1);
    const payload = JSON.parse(refused.stdout);
    expect(payload.code).toBe('STIM_BAD_ARG');
    expect(payload.remedy).toContain(`\`${set}\``);
    expect(payload.remedy).toContain(`stim settings unset ${unset}`);
  },
);

test("start refuses while the project's .stim.json holds the old idle settings at 0, naming their one replacement once", () => {
  const app = join(home, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  writeFileSync(
    join(app, '.stim.json'),
    JSON.stringify({ metro: { idleStopMinutes: 0 }, devices: { idleShutdownMinutes: 0 } }),
  );
  const refused = run(['start'], {}, app);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('STIM_BAD_ARG: metro.idleStopMinutes 0 in');
  expect(refused.stderr.split('stim settings set idle.minutes 0 --scope committed')).toHaveLength(2);
  expect(refused.stderr).toContain('`stim settings unset devices.idleShutdownMinutes`');
  expect(refused.stderr).toContain('`stim settings set idle.minutes 0 --scope committed`');
});
