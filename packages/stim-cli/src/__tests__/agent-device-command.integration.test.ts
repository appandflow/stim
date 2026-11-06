import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceId, workspaceStateDir } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  readAgentSnapshot,
  stimdClaimRoot,
  stimdSocket,
  workspaceAgentDeviceDir,
  workspaceLogsDir,
} from '@stim-cli/core/state';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

const FAKE_AGENT_DEVICE = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const log = (name, value) => appendFileSync(join(process.env.STIM_HOME, name), value + '\\n');
if (args[0] === 'open') {
  log('opens', JSON.stringify(args));
  writeFileSync(join(process.env.STIM_HOME, 'opened'), '');
  process.stdout.write('opened: a snapshot of the app\\n');
  process.exit(0);
}
if (args[0] === 'tap' || args[0] === 'batch') {
  log('taps', JSON.stringify(args));
  if (!existsSync(join(process.env.STIM_HOME, 'opened'))) {
    process.stdout.write(JSON.stringify({ success: false, error: { code: process.env.LOST_AS_LEASE ? 'INVALID_ARGS' : 'SESSION_NOT_FOUND' } }) + '\\n');
    process.stderr.write(process.env.LOST_AS_LEASE ? 'Error (INVALID_ARGS): No active proxy device lease for this session; run open first.\\n' : 'Error (SESSION_NOT_FOUND): iOS snapshot requires an active app session on the target device. Run open first\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ success: true }) + '\\n');
  process.exit(0);
}
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
  const logs = workspaceLogsDir(app);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'build.ndjson'), '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const runCli = (args: string[], cwd = app, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, STIM_HOME: home, STIM_AGENT_DEVICE_BIN: bin, STIM_DAEMON: 'off', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
const run = (args: string[], cwd = app, env: NodeJS.ProcessEnv = {}) => runCli(['agent-device', ...args], cwd, env);

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

test.skipIf(process.platform === 'win32')(
  'a hosted session hands the agent to stimd at once and ends it with no gesture, which its host sends',
  async () => {
    const session = '4f88400a-48eb-4a07-ba6a-734c42768b2a';
    const config = join(home, 'hosted', 'agent.json');
    mkdirSync(workspaceStateDir(app), { recursive: true });
    writeFileSync(
      join(workspaceStateDir(app), 'state.json'),
      JSON.stringify({
        ios: {
          host: {
            machine: 'local:mini',
            session,
            agent: { driver: 'agent-device', remoteConfig: config, command: 'x' },
          },
        },
      }),
    );
    const socket = stimdSocket();
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'stimd' }).acquired;
    const published: unknown[] = [];
    const listener = createServer((peer) => {
      peer.setEncoding('utf8');
      peer.on('data', (data: string) => {
        for (const line of data.split('\n').filter(Boolean)) {
          const { op, params } = JSON.parse(line);
          if (op === 'presence.publish') published.push(params);
          peer.write(`${JSON.stringify({ op: op ?? 'hello' })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => listener.listen(socket, resolve));
    try {
      const child = spawn(process.execPath, [cli, 'agent-device', 'press', '@e1', '--json'], {
        cwd: app,
        env: { ...process.env, STIM_HOME: home, STIM_AGENT_DEVICE_BIN: bin, STIM_DAEMON: 'off' },
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
      await new Promise((resolve) => child.once('close', resolve));
      expect(JSON.parse(stdout).argv).toEqual([
        'press',
        '@e1',
        '--json',
        '--session',
        `stim-default-ios-${workspaceId(app).slice(0, 8)}`,
        '--remote-config',
        config,
      ]);
      expect(published).toEqual([
        { workspace: app, platform: 'ios', command: 'press', phase: 'start' },
        { workspace: app, platform: 'ios', command: 'press', phase: 'end' },
      ]);
    } finally {
      releaseClaim(claim);
      await new Promise((resolve) => listener.close(resolve));
    }
  },
  60_000,
);

describe.skipIf(process.platform === 'win32')('hosted reopen', () => {
  test.each([
    ['SESSION_NOT_FOUND', {}],
    ['No active proxy device lease', { LOST_AS_LEASE: '1' }],
  ])(
    'a hosted command the restarted host no longer knows (%s) opens the recorded app on the same session and runs again',
    (_message, env) => {
      const config = join(home, 'hosted', 'agent.json');
      mkdirSync(workspaceStateDir(app), { recursive: true });
      writeFileSync(
        join(workspaceStateDir(app), 'state.json'),
        JSON.stringify({
          ios: {
            host: {
              machine: 'local:mini',
              session: '4f88400a-48eb-4a07-ba6a-734c42768b2a',
              agent: { driver: 'agent-device', remoteConfig: config, command: 'x' },
            },
          },
          launches: {
            ios: {
              appId: 'com.example.app',
              deviceId: 'hosted',
              metroPort: 8082,
              release: false,
              launchedAt: '2026-11-03T00:00:00.000Z',
            },
          },
        }),
      );
      const result = run(['tap', '@e1', '--json'], app, env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${JSON.stringify({ success: true })}\n`);
      expect(result.stderr).toContain('opening com.example.app again');
      expect(
        readFileSync(join(home, 'opens'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        [
          'open',
          'com.example.app',
          '--session',
          `stim-default-ios-${workspaceId(app).slice(0, 8)}`,
          '--remote-config',
          config,
        ],
      ]);
      expect(readFileSync(join(home, 'taps'), 'utf8').trim().split('\n')).toHaveLength(2);

      const logs = runCli(['logs', '--slot', 'default', '--source', 'agent', '--json']);
      expect(logs.status).toBe(0);
      expect(
        logs.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ).toEqual([expect.objectContaining({ src: 'agent', event: 'agent_action', command: 'tap', platform: 'ios' })]);
      expect(logs.stdout).not.toContain(config);
      expect(logs.stdout).not.toContain('@e1');
    },
    60_000,
  );
});

test.skipIf(process.platform === 'win32')(
  'a multi-step hosted command is never run again after the host lost the session',
  () => {
    const config = join(home, 'hosted', 'agent.json');
    mkdirSync(workspaceStateDir(app), { recursive: true });
    writeFileSync(
      join(workspaceStateDir(app), 'state.json'),
      JSON.stringify({
        ios: {
          host: {
            machine: 'local:mini',
            session: '4f88400a-48eb-4a07-ba6a-734c42768b2a',
            agent: { driver: 'agent-device', remoteConfig: config, command: 'x' },
          },
        },
        launches: {
          ios: {
            appId: 'com.example.app',
            deviceId: 'hosted',
            metroPort: 8082,
            release: false,
            launchedAt: '2026-11-03T00:00:00.000Z',
          },
        },
      }),
    );
    const result = run(['batch', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
    expect(existsSync(join(home, 'opens'))).toBe(false);

    const logs = runCli(['logs', '--source', 'agent', '--level', 'error', '--json']);
    expect(logs.status).toBe(0);
    expect(JSON.parse(logs.stdout)).toMatchObject({ src: 'agent', event: 'agent_failed', command: 'batch' });
    expect(logs.stdout).not.toContain('SESSION_NOT_FOUND');
  },
  60_000,
);

test('a local device that answers the same error is not reopened', () => {
  const result = run(['tap', '@e1']);
  expect(result.status).toBe(1);
  expect(existsSync(join(home, 'opens'))).toBe(false);
});
