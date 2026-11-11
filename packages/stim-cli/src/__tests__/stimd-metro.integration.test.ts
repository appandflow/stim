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
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { readMetroRecords } from '../engine/launch-verify.ts';
import { workspaceDir, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
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
function bareProject({ listens = true, exitsAfterMs = 0 } = {}): string {
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
exports.runServer = ${
      listens
        ? `(config) => new Promise((resolve) => {
  const httpServer = http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : ''));
  httpServer.listen(config.server.port, () => resolve({ httpServer }));${
    exitsAfterMs
      ? `
  setTimeout(() => process.exit(3), ${exitsAfterMs});`
      : ''
  }
})`
        : '() => new Promise(() => setInterval(() => {}, 1000))'
    };`,
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
  try {
    await stopStimd();
    for (const kind of ['metro', 'tunnel']) {
      const root = join(home, 'workspaces');
      for (const workspace of existsSync(root) ? readdirSync(root) : []) {
        const claims = join(root, workspace, `${kind}.claim`, 'exclusive');
        for (const name of existsSync(claims) ? readdirSync(claims) : []) {
          if (!name.endsWith('.child')) continue;
          const { record: child } = JSON.parse(readFileSync(join(claims, name), 'utf8'));
          if (!child || !processGroupAlive(child.pid)) continue;
          if (inspectProcessIdentity(child) !== 'same')
            throw new Error(`Cannot verify fixture process ${child.pid}; retained ${dir}.`);
          process.kill(-child.pid, 'SIGKILL');
          if (!(await waitForProcessExit(child, 5000)))
            throw new Error(`Fixture process ${child.pid} remains; retained ${dir}.`);
          const deadline = Date.now() + 5000;
          while (processGroupAlive(child.pid) && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 50));
          if (processGroupAlive(child.pid))
            throw new Error(`Fixture process group ${child.pid} remains; retained ${dir}.`);
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

test.skipIf(process.platform !== 'win32')(
  'Windows stop and restart preserve managed Metro ownership',
  async () => {
    const root = bareProject();
    rmSync(join(root, '.nvmrc'));
    await startStimd();
    const port = await freePort();
    try {
      const first = await ask('metro.ensure', { root, port });
      expect(first).toMatchObject({ op: 'metro' });
      const stop = spawn(process.execPath, [cli, 'stop'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      stop.stdout?.on('data', (chunk) => (output += String(chunk)));
      stop.stderr?.on('data', (chunk) => (output += String(chunk)));
      const [code] = await once(stop, 'exit');
      if (code !== 0) throw new Error(`stim stop exited ${code}: ${output}`);
      const claims = readClaimSet(join(workspaceDir(root), 'metro.claim'));
      expect(claims.unresolved).toEqual([]);
      expect(claims.live).toEqual([]);
      await expect(ask('metro.ensure', { root, port })).resolves.toMatchObject({ op: 'metro' });
    } finally {
      if (existsSync(workspaceStateFile(root))) {
        const supervisor = JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).supervisor;
        if (supervisor) await ask('metro.stop', { root, pid: supervisor.pid, processToken: supervisor.processToken });
      }
    }
  },
  30_000,
);

test('a Metro that exits by itself releases its claim and stimd keeps serving', async () => {
  const root = bareProject({ exitsAfterMs: 1500 });
  rmSync(join(root, '.nvmrc'));
  const pid = await startStimd();
  const port = await freePort();
  await expect(ask('metro.ensure', { root, port })).resolves.toMatchObject({ op: 'metro', state: 'started' });
  await vi.waitFor(
    () => {
      const claims = readClaimSet(join(workspaceDir(root), 'metro.claim'));
      expect([...claims.live, ...claims.unresolved]).toEqual([]);
    },
    { timeout: 15_000, interval: 100 },
  );
  expect(JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).devServerStop).toMatchObject({
    reason: 'server-exited',
    code: 3,
  });
  expect(alive(pid)).toBe(true);
  await expect(ask('metro.ensure', { root, port })).resolves.toMatchObject({ op: 'metro' });
}, 40_000);

describe.skipIf(process.platform === 'win32')('stimd supervises Metro and tunnel children', () => {
  test('an attached stimd hands over when only a tunnel is running', async () => {
    const root = bareProject();
    write(join(dir, 'bin', 'launchctl'), '#!/bin/sh\nexit 0\n', 0o755);
    write(join(dir, 'bin', 'systemd-run'), '#!/bin/sh\nexit 0\n', 0o755);
    const child = spawn(process.execPath, [cli, '__stimd', '--attached'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    stimd = child;
    await vi.waitFor(() => expect(record()?.pid).toBe(child.pid), { timeout: 15_000, interval: 50 });
    expect(await ask('tick', {})).toHaveProperty('op', 'ticked');
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

  test('attached shutdown seals admission and joins an in-flight tunnel start before releasing home', async () => {
    const root = bareProject();
    const started = join(dir, 'tunnel-started');
    const release = join(dir, 'tunnel-release');
    write(
      join(dir, 'bin', 'cloudflared'),
      `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = --logfile ] && log="$2"; shift; done
touch ${JSON.stringify(started)}
while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.05; done
echo "https://fixture-words.trycloudflare.com" >> "$log"
exec sleep 600
`,
      0o755,
    );
    write(join(dir, 'bin', 'launchctl'), '#!/bin/sh\nexit 0\n', 0o755);
    write(join(dir, 'bin', 'systemd-run'), '#!/bin/sh\nexit 0\n', 0o755);
    const child = spawn(process.execPath, [cli, '__stimd', '--attached'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    stimd = child;
    await vi.waitFor(() => expect(record()?.pid).toBe(child.pid), { timeout: 15_000, interval: 50 });
    expect(await ask('tick', {})).toHaveProperty('op', 'ticked');
    const pending = ask('tunnel.ensure', {
      root,
      provider: 'cloudflared',
      port: await freePort(),
      requireReachable: false,
    });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000, interval: 20 });
      child.stdin?.end();
      await new Promise((done) => setTimeout(done, 700));
      expect(alive(child.pid)).toBe(true);
      expect(await ask('op.begin', {})).toMatchObject({ op: 'error', code: 'daemon-ending' });
      writeFileSync(release, '');
      expect(await pending).toHaveProperty('op', 'tunnel');
      await exited;
      expect(existsSync(join(home, 'run', 'stimd-journal.json'))).toBe(true);
    } finally {
      writeFileSync(release, '');
      await pending.catch(() => {});
    }
  }, 30_000);

  test('when tunnel startup outlasts an attached shutdown, the tunnel claim keeps guarding the child and the home stays recoverable', async () => {
    const root = bareProject();
    const started = join(dir, 'slow-tunnel-started');
    write(join(dir, 'bin', 'cloudflared'), `#!/bin/sh\ntouch ${JSON.stringify(started)}\nexec sleep 600\n`, 0o755);
    const child = spawn(process.execPath, [cli, '__stimd', '--attached'], {
      env: { ...env, STIM_DAEMON_ATTACHED_EXIT_WAIT_SECONDS: '0' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    stimd = child;
    await vi.waitFor(() => expect(record()?.pid).toBe(child.pid), { timeout: 15_000, interval: 50 });
    expect(await ask('tick', {})).toHaveProperty('op', 'ticked');
    void ask('tunnel.ensure', {
      root,
      provider: 'cloudflared',
      port: await freePort(),
      requireReachable: false,
    }).catch(() => {});
    const exited = once(child, 'exit');
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000, interval: 20 });
    child.stdin?.end();
    await exited;
    expect(readClaimSet(join(home, 'run', 'stimd')).unresolved).toEqual([]);
    expect(readClaimSet(join(home, 'daemon', 'claim')).unresolved).toEqual([]);
    const [tunnel] = readClaimSet(join(workspaceDir(root), 'tunnel.claim')).live;
    expect(tunnel?.child).toMatchObject({ pid: expect.any(Number) });
    expect(inspectProcessIdentity(tunnel?.child)).toBe('same');
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
      const retained = parseLease(readFileSync(leasePath, 'utf8'));
      second.socket.destroy();
      await vi.waitFor(async () =>
        expect(await ask('lease.acquire', { ticket: b.ticket }, second.token)).toMatchObject({ op: 'error' }),
      );
      expect(parseLease(readFileSync(leasePath, 'utf8'))).toEqual(retained);
    } finally {
      first.socket.destroy();
      second.socket.destroy();
    }
  }, 30_000);

  test.skipIf(process.platform === 'win32')(
    'retains a run lease when a killed client leaves its installer alive',
    async () => {
      const root = bareProject();
      const other = join(dir, 'other');
      mkdirSync(other);
      await startStimd();
      const { socket: path, build } = record()!;
      const script = join(dir, 'lease-client.cjs');
      write(
        script,
        `
const { connect } = require('node:net');
const { spawn } = require('node:child_process');
const [path, build, root] = process.argv.slice(2);
const socket = connect(path);
let buffer = '', stage = 0, token = '', ticket = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({kind:'cli',build})+'\\n'+JSON.stringify({op:'op.begin',params:{workspace:root,forwarded:{cwd:root,env:{}}}})+'\\n'));
socket.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
    const msg = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
    if (msg.op === 'op.begun') { token = msg.opToken; socket.write(JSON.stringify({op:'lease.prepare',params:{root,platform:'ios',slot:'default',id:'phone',deviceName:null,idLabel:'udid',waitSeconds:0,noWait:false,installBoundMs:60000,appId:null}})+'\\n'); }
    if (msg.op === 'lease.prepared') { ticket = msg.ticket; socket.write(JSON.stringify({op:'lease.acquire',params:{ticket}})+'\\n'); }
    if (msg.op === 'lease.acquired' && !stage++) {
      const installer = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{detached:true,stdio:'ignore'});
      process.stdout.write(JSON.stringify({pid:installer.pid,token,ticket})+'\\n');
    }
  }
});
`,
      );
      const client = spawn(process.execPath, [script, path, build, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let installerPid = 0;
      try {
        const [chunk] = await once(client.stdout!, 'data');
        const { pid, token, ticket } = JSON.parse(String(chunk));
        installerPid = pid;
        expect(alive(installerPid)).toBe(true);
        const exited = once(client, 'exit');
        client.kill('SIGKILL');
        await exited;
        await vi.waitFor(async () =>
          expect(await ask('lease.acquire', { ticket }, token)).toMatchObject({ op: 'error' }),
        );
        const { deviceLeasePath, parseLease } = await import('../engine/device-lease.ts');
        const leasePath = deviceLeasePath('ios', 'phone');
        await vi.waitFor(() => expect(parseLease(readFileSync(leasePath, 'utf8'))?.holder).toBe(root));
        expect(alive(installerPid)).toBe(true);
        const { acquireRunLease } = await import('../engine/device-lease-run.ts');
        expect(
          await acquireRunLease({
            root: other,
            platform: 'ios',
            id: 'phone',
            idLabel: 'udid',
            waitSeconds: 0,
            noWait: false,
            installBoundMs: 60000,
          }),
        ).toMatchObject({ status: 'refused' });
      } finally {
        if (client.exitCode === null && client.signalCode === null) client.kill('SIGKILL');
        if (installerPid && alive(installerPid)) process.kill(-installerPid, 'SIGKILL');
      }
    },
    30_000,
  );

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

  test('a stop does not queue behind a Metro that has not answered yet', async () => {
    const root = bareProject({ listens: false });
    const port = await freePort();
    await startStimd();
    const { socket: path, build } = record() ?? { socket: '', build: '' };
    const starter = connect(path);
    starter.setEncoding('utf8');
    let started = '';
    starter.on('data', (chunk: string) => (started += chunk));
    await once(starter, 'connect');
    starter.write(
      `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'metro.ensure', params: { root, port } })}\n`,
    );
    try {
      const supervisor = await vi.waitFor(
        () => {
          const recorded = JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).supervisor;
          expect(recorded?.pid).toBeTypeOf('number');
          return recorded;
        },
        { timeout: 15_000, interval: 100 },
      );
      const stopped = await Promise.race([
        ask('metro.stop', { root, pid: supervisor.pid, processToken: supervisor.processToken }),
        new Promise((done) => setTimeout(() => done('still queued'), 15_000)),
      ]);
      expect(stopped).toEqual({ op: 'metro.stopped', state: 'stopped' });
      expect(processGroupAlive(supervisor.pid)).toBe(false);
      await vi.waitFor(() => expect(started).toContain('metro-stopping'));
    } finally {
      starter.destroy();
    }
  }, 40_000);

  test('a Metro whose operation ends before it answers stops', async () => {
    const root = bareProject({ listens: false });
    const port = await freePort();
    await startStimd();
    const { socket: path, build } = record() ?? { socket: '', build: '' };
    const operation = connect(path);
    operation.setEncoding('utf8');
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    operation.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    await once(operation, 'connect');
    operation.write(
      `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', params: { workspace: root, forwarded: { cwd: root, env } } })}\n`,
    );
    await vi.waitFor(() => expect(lines[1]?.op).toBe('op.begun'));
    try {
      await expect(ask('metro.prepare', { root, port }, String(lines[1]?.opToken))).resolves.toMatchObject({
        op: 'metro.prepared',
      });
      const supervisor = await vi.waitFor(
        () => {
          const recorded = JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).supervisor;
          expect(recorded?.pid).toBeTypeOf('number');
          return recorded;
        },
        { timeout: 15_000, interval: 100 },
      );
      operation.destroy();
      await vi.waitFor(() => expect(processGroupAlive(supervisor.pid)).toBe(false), { timeout: 15_000, interval: 100 });
      await vi.waitFor(() => {
        const claims = readClaimSet(join(workspaceDir(root), 'metro.claim'));
        expect([...claims.live, ...claims.unresolved]).toEqual([]);
      });
    } finally {
      operation.destroy();
    }
  }, 40_000);

  test('start under daemon.mode off has a stimd adopt a running Metro whose stimd was killed', async () => {
    const root = bareProject();
    write(join(dir, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', 0o755);
    const run = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, stdio: 'pipe' });
      let output = '';
      child.stdout?.on('data', (chunk) => (output += String(chunk)));
      child.stderr?.on('data', (chunk) => (output += String(chunk)));
      const [code] = await once(child, 'exit');
      if (code !== 0) throw new Error(`stim ${args.join(' ')} exited ${code}: ${output}`);
      return output;
    };
    const started = await run(['start']);
    const first = record();
    const metro = JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).supervisor;
    expect(started).toContain(`starting on port ${metro.port} (${metro.mode}, supervisor pid ${metro.pid})`);
    try {
      process.kill(Number(first?.pid), 'SIGKILL');
      await vi.waitFor(() => expect(alive(first?.pid)).toBe(false));
      expect(processGroupAlive(metro.pid)).toBe(true);

      await run(['start'], { STIM_DAEMON: 'off' });
      const next = record();
      expect(next?.pid).not.toBe(first?.pid);
      expect(alive(next?.pid)).toBe(true);
      const claims = readClaimSet(join(workspaceDir(root), 'metro.claim'));
      expect(claims.live.map((holder) => [holder.owner.pid, holder.child?.pid])).toEqual([[next?.pid, metro.pid]]);
    } finally {
      await run(['stop']);
      const last = record()?.pid;
      if (last && alive(last)) process.kill(last, 'SIGTERM');
      await vi.waitFor(() => expect(last === undefined || !alive(last)).toBe(true), { timeout: 15_000 });
    }
    expect(processGroupAlive(metro.pid)).toBe(false);
  }, 90_000);

  test('stop starts a stimd that adopts and stops a Metro whose stimd was killed', async () => {
    const root = bareProject();
    write(join(dir, 'bin', 'launchctl'), '#!/bin/sh\nexit 1\n', 0o755);
    const port = await freePort();
    upsertProject(root, { metroPort: port });
    const killed = await startStimd();
    const metro = await ask('metro.ensure', { root, port });
    expect(metro).toMatchObject({ op: 'metro', state: 'started' });
    stimd?.kill('SIGKILL');
    stimd = null;
    await vi.waitFor(() => expect(alive(killed)).toBe(false));
    expect(processGroupAlive(Number(metro.pid))).toBe(true);
    const stop = spawn(process.execPath, [cli, 'stop'], { cwd: root, env, stdio: 'pipe' });
    let output = '';
    stop.stdout?.on('data', (chunk) => (output += String(chunk)));
    stop.stderr?.on('data', (chunk) => (output += String(chunk)));
    const [code] = await once(stop, 'exit');
    const adopter = record();
    try {
      expect({ code, output }).toMatchObject({ code: 0 });
      expect(adopter?.pid).not.toBe(killed);
      expect(processGroupAlive(Number(metro.pid))).toBe(false);
      const claims = readClaimSet(join(workspaceDir(root), 'metro.claim'));
      expect([...claims.live, ...claims.unresolved]).toEqual([]);
    } finally {
      if (adopter && adopter.pid !== killed && alive(adopter.pid)) process.kill(adopter.pid, 'SIGTERM');
    }
  }, 60_000);

  test("an Expo tunnel's URL is recorded for the workspace's Metro", async () => {
    const root = join(dir, 'expo-tunnel');
    write(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '^50.0.0' } }));
    write(join(root, 'app.json'), JSON.stringify({ name: 'app', platforms: ['ios', 'android'] }));
    write(
      join(root, 'node_modules', 'expo', 'package.json'),
      JSON.stringify({ name: 'expo', version: '50.0.0', bin: { expo: 'bin/cli' } }),
    );
    write(
      join(root, 'node_modules', 'expo', 'bin', 'cli'),
      `#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http')
  .createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : ''))
  .listen(port, () => console.log('Waiting on exp://fixture-tunnel.exp.direct'));
`,
      0o755,
    );
    const port = await freePort();
    await startStimd();
    const workspace = realpathSync(root);
    const started = await ask('metro.ensure', { root: workspace, port, tunnel: true });
    expect(started).toMatchObject({ op: 'metro', mode: 'expo-child' });
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(workspaceStateFile(workspace), 'utf8')).metroTunnel).toEqual({
        kind: 'expo',
        url: 'https://fixture-tunnel.exp.direct',
      }),
    );
  }, 30_000);

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
    const metroClaim = claimFile(root, 'metro');
    const priorClaim = JSON.parse(readFileSync(metroClaim, 'utf8'));
    writeFileSync(
      metroClaim,
      JSON.stringify({ ...priorClaim, details: { ...priorClaim.details, engineDir: 'bbbbbbbbbbbb' } }),
    );
    appendFileSync(join(workspaceLogsDir(root), 'metro.stderr.log'), 'error: written while no stimd ran\n');
    await startStimd();
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(workspaceStateFile(root), 'utf8')).supervisor.engineDir).toBe('bbbbbbbbbbbb'),
    );
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
