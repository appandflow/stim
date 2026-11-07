import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import { readMetroRecords } from '../engine/launch-verify.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { macosAppLogName, macosProcess } from '../macos/state.ts';
import { upsertProject } from '../workspace/config.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = join(repo, 'packages/stim-cli/dist/cli.mjs');

let dir: string;
let home: string;
let env: NodeJS.ProcessEnv;
let stimd: ChildProcess | null = null;

function write(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
}

/** A bare React Native project whose `metro` answers `/status`, pinned by `.nvmrc` to a Node that records its pids. */
function bareProject(): string {
  const root = join(dir, 'bare');
  write(join(root, 'package.json'), JSON.stringify({ name: 'bare', dependencies: { 'react-native': '0.0.0' } }));
  write(join(root, '.nvmrc'), '1.2.3\n');
  const module = (name: string, body: string) => {
    write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    write(join(root, 'node_modules', name, 'index.js'), body);
  };
  module(
    'metro',
    `const http = require('node:http');
exports.loadConfig = async ({ port }) => ({ server: { port }, resolver: { platforms: ['ios'] }, watchFolders: [] });
exports.runServer = (config) => new Promise((resolve) => {
  const httpServer = http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : ''));
  httpServer.listen(config.server.port, () => resolve({ httpServer }));
});`,
  );
  module(
    '@react-native/dev-middleware',
    `exports.createDevMiddleware = () => ({ middleware: (q, s, n) => n(), websocketEndpoints: {} });`,
  );
  module(
    '@react-native-community/cli-server-api',
    `exports.createDevServerMiddleware = () => ({ middleware: (q, s, n) => n(), websocketEndpoints: {} });`,
  );
  write(
    join(dir, 'nvm', 'versions', 'node', 'v1.2.3', 'bin', 'node'),
    `#!/bin/sh\necho $$ >> ${JSON.stringify(join(dir, 'pinned-node'))}\necho "$APP_ENV" >> ${JSON.stringify(join(dir, 'metro-env'))}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    0o755,
  );
  return realpathSync(root);
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, 'listening');
  const address = server.address();
  server.close();
  return typeof address === 'object' && address ? address.port : 0;
}

function record(): { pid: number; socket: string; build: string } | null {
  try {
    return JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function startStimd(mode?: 'off'): Promise<number> {
  const child = spawn(process.execPath, [cli, '__stimd', ...(mode ? ['--mode', mode] : [])], { env, stdio: 'ignore' });
  stimd = child;
  await vi.waitFor(() => expect(record()?.pid).toBe(child.pid), { timeout: 15_000, interval: 50 });
  return child.pid ?? 0;
}

async function stopStimd(): Promise<void> {
  const child = stimd;
  stimd = null;
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function ask(op: string, params: Record<string, unknown>, opToken?: string): Promise<Record<string, unknown>> {
  const { socket: path, build } = record() ?? { socket: '', build: '' };
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let lines = 0;
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op, params, ...(opToken ? { opToken } : {}) })}\n`,
      ),
    );
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (lines++ === 0) continue;
        socket.destroy();
        resolve(JSON.parse(line));
      }
    });
  });
}

function alive(pid: unknown): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function claimFile(root: string, kind: string): string {
  const exclusive = join(workspaceDir(root), `${kind}.claim`, 'exclusive');
  const name = readdirSync(exclusive).find((entry) => entry.endsWith('.claim'));
  return join(exclusive, name ?? '');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  home = join(dir, 'home');
  mkdirSync(home);
  write(
    join(dir, 'bin', 'cloudflared'),
    `#!/bin/sh\necho "$APP_ENV" >> ${JSON.stringify(join(dir, 'tunnel-env'))}\n` +
      'while [ $# -gt 0 ]; do [ "$1" = --logfile ] && log="$2"; shift; done\n' +
      'echo "https://fixture-words.trycloudflare.com" >> "$log"\nexec sleep 600\n',
    0o755,
  );
  env = {
    ...process.env,
    STIM_HOME: home,
    STIM_ENGINE_ROOT: join(dir, 'engine'),
    STIM_DAEMON: 'on',
    NVM_DIR: join(dir, 'nvm'),
    PATH: [join(dir, 'bin'), process.env.PATH].join(delimiter),
  };
  vi.stubEnv('STIM_HOME', home);
});

afterEach(async () => {
  await stopStimd();
  for (const kind of ['metro', 'tunnel']) {
    const root = join(home, 'workspaces');
    for (const workspace of existsSync(root) ? readdirSync(root) : []) {
      const claims = join(root, workspace, `${kind}.claim`, 'exclusive');
      for (const name of existsSync(claims) ? readdirSync(claims) : []) {
        if (!name.endsWith('.child')) continue;
        const { record: child } = JSON.parse(readFileSync(join(claims, name), 'utf8'));
        if (child && processGroupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
      }
    }
  }
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('stimd supervises Metro and tunnel children', () => {
  test('off-mode keeps an owned macOS tail alive and drains final output', async () => {
    const root = bareProject();
    upsertProject(root, {});
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('the app did not start');
    const app = macosProcess(child.pid);
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    const raw = join(logs, macosAppLogName('off-mode', 'out'));
    writeFileSync(raw, 'off mode output\n');
    writeWorkspaceState(root, {
      macos: {
        launchId: 'off-mode',
        product: 'Fixture',
        arguments: [],
        bundle: root,
        bundleId: 'fixture',
        executable: process.execPath,
        build: { state: 'ok', startedAt: new Date().toISOString() },
        app,
        supervisor: app,
      },
    });
    try {
      await startStimd('off');
      await vi.waitFor(() => expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('off mode output'));
      appendFileSync(raw, 'final off mode output\n');
      child.kill('SIGKILL');
      await once(child, 'exit');
      expect(await ask('logs.drain', { root })).toMatchObject({ op: 'logs.drained', error: null });
      expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('final off mode output');
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);
  test('invalid UTF-8 in app output does not block the daemon', async () => {
    const root = bareProject();
    const app = macosProcess(process.pid);
    writeWorkspaceState(root, {
      macos: {
        launchId: 'invalid-utf8',
        product: 'Fixture',
        arguments: [],
        bundle: root,
        bundleId: 'fixture',
        executable: process.execPath,
        build: { state: 'ok', startedAt: new Date().toISOString() },
        app,
        supervisor: app,
      },
    });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, macosAppLogName('invalid-utf8', 'out')), Buffer.alloc(65_537, 0x80));
    await startStimd();
    try {
      const response = await Promise.race([
        ask('logs.observe', { root }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stimd did not answer')), 3000)),
      ]);
      expect(response.op).toBe('logs.observed');
    } finally {
      if (stimd && stimd.exitCode === null) stimd.kill('SIGKILL');
    }
  });
  test('an attached stimd hands over when only a tunnel is running', async () => {
    const root = bareProject();
    write(join(dir, 'bin', 'launchctl'), '#!/bin/sh\nexit 0\n', 0o755);
    write(join(dir, 'bin', 'systemd-run'), '#!/bin/sh\nexit 0\n', 0o755);
    const child = spawn(process.execPath, [cli, '__stimd', '--attached'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    stimd = child;
    await vi.waitFor(() => expect(record()?.pid).toBe(child.pid), { timeout: 15_000, interval: 50 });
    await expect(
      ask('tunnel.ensure', { root, provider: 'cloudflared', port: await freePort(), requireReachable: false }),
    ).resolves.toMatchObject({ op: 'tunnel' });
    const exited = once(child, 'exit');
    child.stdin?.end();
    await exited;
    expect(JSON.parse(readFileSync(join(home, 'run', 'stimd-journal.json'), 'utf8')).alive).toBe(
      'Metro or a tunnel is running',
    );
  }, 30_000);

  test("metro.ensure starts Metro through metro-host.cjs on the project's Node, and a warm child answers at once", async () => {
    const root = bareProject();
    const port = await freePort();
    const stimdPid = await startStimd();
    const started = await ask('metro.ensure', { root, port });
    expect(started).toMatchObject({ op: 'metro', state: 'started', port, mode: 'bare-inproc' });
    expect(readFileSync(join(dir, 'pinned-node'), 'utf8').trim().split('\n')).toContain(String(started.pid));
    expect(JSON.parse(readFileSync(join(workspaceDir(root), 'metro.heartbeat'), 'utf8'))).toMatchObject({
      pid: started.pid,
      port,
    });
    const state = JSON.parse(readFileSync(join(workspaceDir(root), 'state.json'), 'utf8'));
    expect(state.supervisor).toMatchObject({ pid: started.pid, port });
    const ps = spawn('ps', ['-o', 'ppid=', '-p', String(started.pid)]);
    let ppid = '';
    ps.stdout.on('data', (chunk) => (ppid += chunk));
    await once(ps, 'exit');
    expect(Number(ppid)).toBe(stimdPid);
    expect(await (await fetch(`http://localhost:${port}/status`)).text()).toBe('packager-status:running');
    await expect(ask('metro.ensure', { root, port })).resolves.toEqual({ ...started, state: 'running' });
  });

  test('a Metro request uses its operation environment when another operation begins later', async () => {
    const root = bareProject();
    const port = await freePort();
    await startStimd();
    const { socket: path, build } = record() ?? { socket: '', build: '' };
    const open = async (value: string) => {
      const socket = connect(path);
      socket.setEncoding('utf8');
      const lines: Record<string, unknown>[] = [];
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          lines.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
      });
      await once(socket, 'connect');
      socket.write(
        `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', params: { workspace: root, forwarded: { cwd: root, env: { ...env, APP_ENV: value } } } })}\n`,
      );
      await vi.waitFor(() => expect(lines[1]?.op).toBe('op.begun'));
      return { socket, lines };
    };
    const first = await open('first');
    const second = await open('second');
    try {
      first.socket.write(`${JSON.stringify({ op: 'metro.ensure', params: { root, port } })}\n`);
      await vi.waitFor(() => expect(first.lines[2]).toMatchObject({ op: 'metro', state: 'started' }), {
        timeout: 15_000,
      });
      expect(readFileSync(join(dir, 'metro-env'), 'utf8').trim()).toBe('first');
      first.socket.write(
        `${JSON.stringify({ op: 'tunnel.ensure', params: { root, port, provider: 'cloudflared', requireReachable: false } })}\n`,
      );
      await vi.waitFor(() => expect(first.lines[3]).toMatchObject({ op: 'tunnel' }), { timeout: 15_000 });
      expect(readFileSync(join(dir, 'tunnel-env'), 'utf8').trim()).toBe('first');
    } finally {
      first.socket.destroy();
      second.socket.destroy();
    }
  });

  test('operation tickets preserve shared device leases and the requesting Metro environment', async () => {
    const root = bareProject();
    const port = await freePort();
    await startStimd();
    const { socket: path, build } = record() ?? { socket: '', build: '' };
    const open = async (value: string) => {
      const socket = connect(path);
      socket.setEncoding('utf8');
      const lines: Record<string, unknown>[] = [];
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          lines.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
      });
      await once(socket, 'connect');
      socket.write(
        `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', params: { workspace: root, forwarded: { cwd: root, env: { ...env, APP_ENV: value } } } })}\n`,
      );
      await vi.waitFor(() => expect(lines[1]?.op).toBe('op.begun'));
      return { socket, token: String(lines[1]?.opToken) };
    };
    const first = await open('first-ticket');
    const second = await open('second-ticket');
    const request = {
      root,
      platform: 'ios',
      slot: 'default',
      id: 'phone',
      deviceName: null,
      idLabel: 'udid',
      waitSeconds: 0,
      noWait: false,
      installBoundMs: 60_000,
      appId: null,
    };
    try {
      const a = await ask('lease.prepare', request, first.token);
      const b = await ask('lease.prepare', request, second.token);
      const leaseA = await ask('lease.acquire', { ticket: a.ticket }, first.token);
      const leaseB = await ask('lease.acquire', { ticket: b.ticket }, second.token);
      expect(leaseA).toMatchObject({ op: 'lease.acquired', result: { status: 'leased', kind: 'run' } });
      expect(leaseB).toMatchObject({ op: 'lease.acquired', result: { status: 'leased', kind: 'run' } });
      const { deviceLeasePath, parseLease } = await import('../engine/device-lease.ts');
      const leasePath = deviceLeasePath('ios', 'phone');
      first.socket.destroy();
      await vi.waitFor(async () =>
        expect(await ask('lease.acquire', { ticket: a.ticket }, first.token)).toMatchObject({ op: 'error' }),
      );
      expect(parseLease(readFileSync(leasePath, 'utf8'))?.holder).toBe(root);
      const metro = await ask('metro.prepare', { root, port }, second.token);
      expect(metro).toMatchObject({ op: 'metro.prepared', state: 'starting', ticket: expect.any(String) });
      expect(await ask('metro.wait', { ticket: metro.ticket }, second.token)).toMatchObject({
        op: 'metro',
        state: 'started',
      });
      expect(readFileSync(join(dir, 'metro-env'), 'utf8').trim()).toBe('second-ticket');
      second.socket.destroy();
      await vi.waitFor(() => expect(existsSync(leasePath)).toBe(false));
    } finally {
      first.socket.destroy();
      second.socket.destroy();
    }
  }, 30_000);

  test('an operation starts a log stream and its token expires when the operation disconnects', async () => {
    const root = bareProject();
    const pidFile = join(dir, 'log-pid');
    write(
      join(dir, 'bin', 'xcrun'),
      `#!/bin/sh\necho $$ > "$TEST_PID"\necho '{"eventType":"logEvent","eventMessage":"device ready"}'\nexec sleep 600\n`,
      0o755,
    );
    await startStimd();
    const { socket: path, build } = record() ?? { socket: '', build: '' };
    const socket = connect(path);
    socket.setEncoding('utf8');
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    await once(socket, 'connect');
    socket.write(
      `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', params: { workspace: root, forwarded: { cwd: root, env: { ...env, TEST_PID: pidFile } } } })}\n`,
    );
    await vi.waitFor(() => expect(lines[1]?.op).toBe('op.begun'));
    const token = String(lines[1]?.opToken);
    const spec = { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
    try {
      const started = await ask('logs.start', spec, token);
      expect(started).toMatchObject({ op: 'logs.started', streamId: expect.any(String) });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      await vi.waitFor(() => {
        const records = readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8');
        expect(records).toContain('device ready');
      });
      const pid = Number(readFileSync(pidFile, 'utf8'));
      socket.destroy();
      await vi.waitFor(async () =>
        expect(await ask('logs.start', spec, token)).toMatchObject({ op: 'error', code: 'bad-workspace' }),
      );
      expect(await ask('logs.stop', { root, platform: 'ios', slot: 'default', streamId: started.streamId })).toEqual({
        op: 'logs.stopped',
        stopped: true,
      });
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      socket.destroy();
    }
  });

  test('a stale heartbeat whose /status probe fails restarts Metro', async () => {
    const root = bareProject();
    const port = await freePort();
    await startStimd();
    const first = await ask('metro.ensure', { root, port });
    process.kill(Number(first.pid), 'SIGSTOP');
    const heartbeat = join(workspaceDir(root), 'metro.heartbeat');
    await vi.waitFor(() => expect(Date.now() - JSON.parse(readFileSync(heartbeat, 'utf8')).at).toBeGreaterThan(3000), {
      timeout: 6000,
      interval: 200,
    });
    const restarted = await ask('metro.ensure', { root, port });
    expect(restarted).toMatchObject({ state: 'started', port });
    expect(restarted.pid).not.toBe(first.pid);
    expect(alive(first.pid)).toBe(false);
  }, 30_000);

  test('a restarted stimd re-adopts its Metro and tunnel by claim and reads the output it missed; a Metro of other injected files is foreign until a launch restarts it', async () => {
    const root = bareProject();
    const port = await freePort();
    await startStimd();
    const metro = await ask('metro.ensure', { root, port });
    const tunnel = await ask('tunnel.ensure', { root, provider: 'cloudflared', port, requireReachable: false });
    expect(tunnel).toMatchObject({ op: 'tunnel', url: 'https://fixture-words.trycloudflare.com' });

    await stopStimd();
    expect([alive(metro.pid), alive(tunnel.pid)]).toEqual([true, true]);
    appendFileSync(join(workspaceLogsDir(root), 'metro.stderr.log'), 'error: written while no stimd ran\n');
    await startStimd();
    await vi.waitFor(
      () =>
        expect(readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8')).toContain(
          'written while no stimd ran',
        ),
      { timeout: 5000, interval: 100 },
    );
    await expect(ask('metro.ensure', { root, port })).resolves.toEqual({ ...metro, state: 'running' });
    await expect(ask('tunnel.ensure', { root, provider: 'cloudflared', port })).resolves.toEqual(tunnel);

    await stopStimd();
    const claim = claimFile(root, 'metro');
    const held = JSON.parse(readFileSync(claim, 'utf8'));
    writeFileSync(claim, JSON.stringify({ ...held, details: { ...held.details, digest: 'other-injected' } }));
    appendFileSync(
      join(workspaceLogsDir(root), 'metro.ndjson'),
      `${JSON.stringify({ ts: Date.now(), src: 'metro', event: 'bundle_response_started', inj: 'other-injected' })}\n`,
    );
    await startStimd();
    await expect(ask('metro.ensure', { root, port })).resolves.toEqual({ ...metro, state: 'running', foreign: true });
    await expect(ask('op.begin', { workspace: root })).resolves.toEqual({ op: 'op.begun', metroForeign: true });
    expect(readMetroRecords(workspaceLogsDir(root)).some((entry) => entry.inj === 'other-injected')).toBe(false);

    const restarted = await ask('metro.ensure', { root, port, launch: true });
    expect(restarted).toMatchObject({ state: 'started', port });
    expect(restarted).not.toHaveProperty('foreign');
    expect(restarted.pid).not.toBe(metro.pid);
    expect(alive(metro.pid)).toBe(false);
  }, 60_000);

  test('an Expo project gets the Expo CLI, not metro-host.cjs', async () => {
    const root = join(dir, 'expo-app');
    write(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '^57.0.0' } }));
    write(join(root, 'app.json'), JSON.stringify({ name: 'app', platforms: ['ios', 'android'] }));
    write(
      join(root, 'node_modules', 'expo', 'package.json'),
      JSON.stringify({ name: 'expo', version: '57.0.0', bin: { expo: 'bin/cli' } }),
    );
    write(
      join(root, 'node_modules', 'expo', 'bin', 'cli'),
      '#!/usr/bin/env node\nconsole.error(`expo ${process.argv.slice(2).join(" ")}`);\nprocess.exit(1);\n',
      0o755,
    );
    const port = await freePort();
    await startStimd();
    await expect(ask('metro.ensure', { root: realpathSync(root), port })).resolves.toEqual({
      op: 'error',
      code: 'metro-exited',
      message: `expo start --port ${port}`,
    });
  });
});
