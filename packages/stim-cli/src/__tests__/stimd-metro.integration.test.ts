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
    `#!/bin/sh\necho $$ >> ${JSON.stringify(join(dir, 'pinned-node'))}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
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

async function startStimd(): Promise<number> {
  const child = spawn(process.execPath, [cli, '__stimd'], { env, stdio: 'ignore' });
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

function ask(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { socket: path, build } = record() ?? { socket: '', build: '' };
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let lines = 0;
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op, params })}\n`),
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
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --logfile ] && log="$2"; shift; done\n' +
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
