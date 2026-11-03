import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceStateDir } from '@stim-cli/core';
import { readAgentSnapshot, serverLocalSocket, workspaceAgentDeviceDir } from '@stim-cli/core/state';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

const FAKE_AGENT_DEVICE = `
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'snapshot') {
  process.stdout.write(JSON.stringify({ nodes: [{ ref: 'e2', rect: { x: 100, y: 200, width: 200, height: 100 } }], viewport: { width: 400, height: 800 } }) + '\\n');
  process.exit(0);
}
if (args[0] === 'die') process.kill(process.pid, 'SIGTERM');
if (args[0] === 'press' && process.env.AGENT_DEVICE_STATE_DIR) {
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

test.skipIf(process.platform === 'win32')(
  'an agent-device killed by a signal exits with 128 plus the signal, as a shell reports it (Windows has no POSIX signals, process.kill ends the child with code 1; skipped on win32)',
  () => {
    expect(run(['die']).status).toBe(143);
  },
);

test('a hosted session shows the agent to stim-server at once and ends it with no gesture, which its host sends', async () => {
  const session = '4f88400a-48eb-4a07-ba6a-734c42768b2a';
  const config = join(home, 'hosted', 'agent.json');
  mkdirSync(workspaceStateDir(app), { recursive: true });
  writeFileSync(
    join(workspaceStateDir(app), 'state.json'),
    JSON.stringify({
      ios: {
        host: { machine: 'local:mini', session, agent: { driver: 'agent-device', remoteConfig: config, command: 'x' } },
      },
    }),
  );
  const socket = serverLocalSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const published: unknown[] = [];
  const listener = createServer();
  const sockets = new WebSocketServer({ server: listener });
  sockets.on('connection', (peer) =>
    peer.on('message', (data) => {
      const { id, method, params } = JSON.parse(data.toString());
      if (method === 'presence.publish') published.push(params);
      peer.send(JSON.stringify({ id, result: {} }));
    }),
  );
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  try {
    const child = spawn(process.execPath, [cli, 'agent-device', 'press', '@e1', '--json'], {
      cwd: app,
      env: { ...process.env, STIM_HOME: home, STIM_AGENT_DEVICE_BIN: bin, STIM_DAEMON: 'off' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    await new Promise((resolve) => child.once('close', resolve));
    expect(JSON.parse(stdout).argv).toEqual(['press', '@e1', '--json', '--remote-config', config]);
    expect(published).toEqual([
      { workspace: app, platform: 'ios', command: 'press', phase: 'start' },
      { workspace: app, platform: 'ios', command: 'press', phase: 'end' },
    ]);
  } finally {
    sockets.close();
    await new Promise((resolve) => listener.close(resolve));
  }
}, 60_000);
