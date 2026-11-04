import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let home: string;
let project: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ports-reverse-')));
  project = join(home, 'app');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'react-native': '*' } }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const stim = (...args: string[]) => {
  const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'ports', ...args], {
    cwd: project,
    env: { ...process.env, STIM_HOME: home, STIM_DAEMON: 'off' },
    encoding: 'utf8',
  });
  return { stdout: run.stdout.trim(), status: run.status };
};

test('ports reverse and ports print one JSON payload with --json wherever the flag stands', () => {
  const added = stim('reverse', '9000', '--json');
  expect(JSON.parse(added.stdout)).toEqual({ action: 'add', port: 9000, ports: [9000], devices: [] });
  expect(JSON.parse(stim('--json').stdout)).toMatchObject({ reverses: [{ port: 9000, label: null }] });
  expect(stim('reverse', '--json', '--remove', '9000').stdout).toContain('"action":"remove"');
  expect(JSON.parse(stim('--json').stdout).reverses).toEqual([]);
});

test('ports reverse refuses a label that was never allocated and records nothing', () => {
  expect(stim('reverse', 'api').status).toBe(1);
  expect(JSON.parse(stim('--json').stdout).reverses).toEqual([]);
});
