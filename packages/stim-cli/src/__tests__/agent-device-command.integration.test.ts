import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentSnapshot, workspaceAgentDeviceDir } from '@stim-cli/core/state';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

const FAKE_AGENT_DEVICE = `
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'snapshot') {
  process.stdout.write(JSON.stringify({ nodes: [{ ref: 'e2', rect: { x: 100, y: 200, width: 200, height: 100 } }], viewport: { width: 400, height: 800 } }) + '\\n');
  process.exit(0);
}
if (args[0] === 'press') {
  const session = args[args.indexOf('--session') + 1];
  const dir = join(process.env.AGENT_DEVICE_STATE_DIR, 'sessions', session);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.ndjson'), JSON.stringify({ version: 1, ts: new Date().toISOString(), session, kind: 'action.recorded', command: 'press', details: { x: 200, y: 250 } }) + '\\n');
}
process.stdout.write(JSON.stringify({ argv: args, stateDir: process.env.AGENT_DEVICE_STATE_DIR ?? null }));
process.stderr.write('agent-device stderr\\n');
process.exit(3);
`;

let home: string;
let app: string;
let bin: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-agent-device-cli-')));
  app = join(home, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: { [app]: { metroPort: 8082, platforms: { ios: { deviceUdid: 'SIM-1', owned: true } } } },
      repos: {},
    }),
  );
  mkdirSync(join(home, 'agent-device', 'bin'), { recursive: true });
  writeFileSync(join(home, 'agent-device', 'package.json'), JSON.stringify({ version: '0.21.35' }));
  bin = join(home, 'agent-device', 'bin', 'agent-device.mjs');
  writeFileSync(bin, FAKE_AGENT_DEVICE);
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const run = (args: string[], cwd = app) =>
  spawnSync(process.execPath, [cli, 'agent-device', ...args], {
    cwd,
    env: { ...process.env, STIM_HOME: home, STIM_AGENT_DEVICE_BIN: bin, STIM_DAEMON: 'off' },
    encoding: 'utf8',
    timeout: 60_000,
  });

test("passes agent-device's stdout, stderr and exit code through, with the workspace's device injected", () => {
  const result = run(['press', '@e2', '--json']);
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toEqual({
    argv: ['press', '@e2', '--json', '--platform', 'ios', '--udid', 'SIM-1', '--session', 'stim-default-ios'],
    stateDir: workspaceAgentDeviceDir(app),
  });
  expect(result.stderr).toContain('agent-device stderr');
});

test('tees a JSON snapshot byte for byte and keeps its tree for later outlines', () => {
  const result = run(['snapshot', '-i', '--json']);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    `${JSON.stringify({ nodes: [{ ref: 'e2', rect: { x: 100, y: 200, width: 200, height: 100 } }], viewport: { width: 400, height: 800 } })}\n`,
  );
  expect(readAgentSnapshot(app, 'stim-default-ios')).toEqual({
    viewport: { width: 400, height: 800 },
    nodes: [{ ref: 'e2', rect: { x: 100, y: 200, width: 200, height: 100 } }],
  });
});

test('refuses boot and a foreign device with one JSON payload, without running agent-device', () => {
  for (const args of [
    ['boot', '--json'],
    ['press', '@e1', '--udid', 'OTHER', '--json'],
  ]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'STIM_BAD_ARG' });
    expect(result.stderr).not.toContain('agent-device stderr');
  }
  expect(existsSync(join(workspaceAgentDeviceDir(app), 'sessions'))).toBe(false);
});

test('agent-device --help needs no workspace', () => {
  const result = run(['--help'], home);
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toEqual({ argv: ['--help'], stateDir: null });
});
