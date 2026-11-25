import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workspaceStateDir } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { DESKTOP_API, PHONE_API } from '@stim-cli/core/protocol';
import { daemonNdjsonFile, desktopKeyFile, isJsonObject, stimBuildDigest, stimdRecordFile } from '@stim-cli/core/state';
import { noiseConnect, stimdConnect, terminateClients } from '../../../server/__tests__/noise-client.ts';

const execute = promisify(execFile);
const root = join(import.meta.dirname, '../../../..');

test('the router reports its package version, and serve its help', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-serve-cli-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const version = JSON.parse(readFileSync(join(root, 'packages/stim-cli/package.json'), 'utf8')).version;
  try {
    const printed = await execute(process.execPath, [join(root, 'packages/stim-cli/bin/stim.mjs'), '--version'], {
      env,
    });
    expect(printed.stdout.trim()).toBe(version);
    for (const command of ['serve', 'ci']) {
      const reported = await execute(
        process.execPath,
        [join(root, 'packages/stim-cli/bin/stim.mjs'), command, '--version'],
        { env },
      );
      expect(reported.stdout.trim()).toBe(version);
    }
    for (const args of [['--help'], ['serve', '--help']]) {
      await execute(process.execPath, [join(root, 'packages/stim-cli/bin/stim.mjs'), ...args], { env });
    }
    for (const narrower of ['--loopback-only', '--share']) {
      const refused = await execute(
        process.execPath,
        [join(root, 'packages/stim-cli/bin/stim.mjs'), 'serve', '--tailnet', narrower],
        { env },
      ).catch((error: { code: number; stderr: string }) => error);
      expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('STIM_BAD_ARG') });
    }
    expect(existsSync(join(home, 'server', 'tailnet.json'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

/** The lines a child writes to `stream`, and a wait for the first one `pattern` matches. */
function lines(stream: NodeJS.ReadableStream) {
  let text = '';
  stream.on('data', (chunk) => {
    text += String(chunk);
  });
  return {
    text: () => text,
    match: async (pattern: RegExp, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = pattern.exec(text);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${pattern} in:\n${text}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    },
  };
}

/** The nonce of the Desktop challenge a `hello` with `desktopBootstrap` answers with. */
function nonceOf(reply: unknown): string {
  const result = isJsonObject(reply) && isJsonObject(reply.result) ? reply.result : {};
  const challenge = isJsonObject(result.desktopBootstrap) ? result.desktopBootstrap : {};
  assert.ok(typeof challenge.nonce === 'string', JSON.stringify(reply));
  return challenge.nonce;
}

const proofFor = (key: string, nonce: string) =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(`client:${nonce}`).digest('base64url');

test('stimd starts its net thread only when asked, and serves pairings, local clients and its Desktop key through it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-thread-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const version = JSON.parse(readFileSync(join(root, 'packages/stim-cli/package.json'), 'utf8')).version;
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stimdExited = once(stimd, 'exit');
  const stimdOut = lines(stimd.stdout);
  let attached: ReturnType<typeof spawn> | undefined;
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const key = readFileSync(desktopKeyFile(), 'utf8').trim();
    expect(process.platform === 'win32' || (statSync(desktopKeyFile()).mode & 0o777) === 0o600).toBe(true);

    await expect(stimdConnect(socket)).rejects.toThrow(/net-off/);
    expect(stimdOut.text()).not.toMatch(/listening on/);

    const serve = spawn(
      process.execPath,
      [join(root, 'packages/stim-cli/bin/stim.mjs'), 'serve', '--port', '0', '--loopback-only'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    attached = serve;
    const attachedExited = once(serve, 'exit');
    const port = Number((await lines(serve.stdout).match(/listens on port (\d+)/))[1]);
    expect(port).toBeGreaterThan(0);

    const signal = AbortSignal.timeout(10_000);
    let response;
    let health: unknown;
    do {
      response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
      health = await response.json();
    } while (response.status === 503);
    expect(health).toMatchObject({
      server: 'stim-server',
      version,
      stimBuild: stimBuildDigest(join(root, 'packages/stim-cli/dist')),
      startup: { state: 'ready' },
    });
    expect(stimBuildDigest(join(root, 'packages/stim-cli/dist'))).toMatch(/^[0-9a-f]{16}$/);

    const paired = await execute(
      process.execPath,
      [join(root, 'packages/stim-cli/bin/stim.mjs'), 'pair', '--json', '--port', String(port)],
      { env },
    );
    const phone = await noiseConnect(`ws://127.0.0.1:${port}`, {
      secret: JSON.parse(paired.stdout).qr.pairingToken,
      name: 'Test phone',
    });
    const hello = await phone.request('hello', {
      client: { name: 'stim-mobile', version: '1.0.0', phoneApi: PHONE_API },
    });
    assert.ok('result' in hello, JSON.stringify(hello));
    phone.socket.terminate();

    const desktop = await stimdConnect(socket);
    const challenged = await desktop.request('hello', {
      client: { name: 'Stim Desktop', version: '1.0.0', desktopApi: DESKTOP_API },
      desktopBootstrap: true,
    });
    const authorized = await desktop.request('desktop.authenticate', { proof: proofFor(key, nonceOf(challenged)) });
    expect(authorized).toMatchObject({ result: { authorized: true } });
    desktop.socket.terminate();

    const stranger = await stimdConnect(socket);
    const strangerHello = await stranger.request('hello', {
      client: { name: 'Stim Desktop', version: '1.0.0', desktopApi: DESKTOP_API },
      desktopBootstrap: true,
    });
    const refused = await stranger.request('desktop.authenticate', {
      proof: proofFor(Buffer.alloc(32, 1).toString('base64url'), nonceOf(strangerHello)),
    });
    expect(refused).toMatchObject({ error: { code: 'forbidden' } });
    stranger.socket.terminate();

    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
    await attachedExited;
    expect(existsSync(stimdRecordFile())).toBe(false);
  } finally {
    terminateClients();
    for (const child of [stimd, attached])
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

/** Asks stimd at `socket` for its net thread as Stim Desktop does, and resolves with the `net` answer. */
function desktopEnsure(socket: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('error', reject);
    client.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const reply = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (reply.op === 'net') {
          client.destroy();
          resolve(reply);
        }
      }
    });
    client.write(`${JSON.stringify({ kind: 'desktop' })}\n${JSON.stringify({ op: 'net.ensure', params })}\n`);
  });
}

test('a Desktop net.ensure with other listener options restarts the net thread with them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-restart-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const loopback = await desktopEnsure(socket, { port: 0, loopbackOnly: true });
    expect(loopback).toMatchObject({ listening: true });
    expect(await desktopEnsure(socket, { port: 0, loopbackOnly: true })).toEqual(loopback);
    const wider = await desktopEnsure(socket, { port: 0, loopbackOnly: false });
    expect(wider).toMatchObject({ listening: true });
    expect(wider.port).not.toBe(loopback.port);
    await expect(fetch(`http://127.0.0.1:${loopback.port}/health`)).rejects.toThrow('fetch failed');
    expect((await fetch(`http://127.0.0.1:${wider.port}/health`)).status).toBeLessThan(600);
    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('a Desktop net.ensure keeps the running listener while busy and applies the options once the action ends', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-net-busy-')));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const workspace = join(home, 'app');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  const state = join(workspaceStateDir(workspace), 'state.json');
  mkdirSync(workspaceStateDir(workspace), { recursive: true });
  writeFileSync(state, JSON.stringify({ launches: {} }));
  let lock: ReturnType<typeof tryAcquireClaim>['acquired'];
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  try {
    await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 15_000 });
    const { socket } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const loopback = await desktopEnsure(socket, { port: 0, loopbackOnly: true });
    expect(loopback).toMatchObject({ listening: true });
    await vi.waitFor(
      async () => {
        expect((await fetch(`http://127.0.0.1:${loopback.port}/health`)).status).toBe(200);
      },
      { timeout: 15_000 },
    );
    const desktop = await stimdConnect(socket);
    const challenged = await desktop.request('hello', {
      client: { name: 'Stim Desktop', version: '1.0.0', desktopApi: DESKTOP_API },
      desktopBootstrap: true,
    });
    const key = readFileSync(desktopKeyFile(), 'utf8').trim();
    expect(await desktop.request('desktop.authenticate', { proof: proofFor(key, nonceOf(challenged)) })).toMatchObject({
      result: { authorized: true },
    });
    lock = tryAcquireClaim({ root: join(home, 'config.lock.claims'), mode: 'exclusive' }).acquired;
    assert.ok(lock);
    expect(await desktop.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
    expect(await desktop.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'action-busy',
    );
    const wider = await desktopEnsure(socket, { port: 0, loopbackOnly: false });
    expect(wider).toEqual(loopback);
    expect((await fetch(`http://127.0.0.1:${loopback.port}/health`)).status).toBeLessThan(600);
    expect(readFileSync(daemonNdjsonFile(), 'utf8')).not.toContain('net_restart');
    releaseClaim(lock);
    lock = undefined;
    await logged('"net_restart"');
    await vi.waitFor(async () => {
      await expect(fetch(`http://127.0.0.1:${loopback.port}/health`)).rejects.toThrow('fetch failed');
    });
    const restarted = await desktopEnsure(socket, { port: 0, loopbackOnly: false });
    expect(restarted).toMatchObject({ listening: true });
    expect(restarted.port).not.toBe(loopback.port);
    expect((await fetch(`http://127.0.0.1:${restarted.port}/health`)).status).toBe(200);
    terminateClients();
    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    if (lock) releaseClaim(lock);
    terminateClients();
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

/** Asks stimd at `socket` for its net thread with the first frame `first`, and resolves with the `net` answer. */
function ensureAs(
  socket: string,
  first: Record<string, unknown>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('error', reject);
    client.on('close', () => reject(new Error('stimd closed the connection without an answer')));
    client.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const reply = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (reply.op === 'net') {
          client.destroy();
          resolve(reply);
        }
      }
    });
    client.write(`${JSON.stringify(first)}\n${JSON.stringify({ op: 'net.ensure', params })}\n`);
  });
}

/** A TCP port nothing listens on at the time of the call. */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

test("a service process that finds a stimd serving a share-only net thread on another port moves it to the service's port", async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-service-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stimdErr = lines(stimd.stderr);
  const stimdExited = once(stimd, 'exit');
  let service: ReturnType<typeof spawn> | undefined;
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const shared = await desktopEnsure(socket, { share: true });
    expect(shared).toMatchObject({ listening: true });
    const port = await freePort();
    expect(shared.port).not.toBe(port);

    const child = spawn(
      process.execPath,
      [
        join(root, 'packages/stim-cli/dist/cli.mjs'),
        '__stimd',
        '--service',
        '--port',
        String(port),
        '--env',
        'STIM_TEST_SERVICE_ONLY',
      ],
      { env: { ...env, STIM_TEST_SERVICE_ONLY: 'from-the-unit' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    service = child;
    const serviceErr = lines(child.stderr);
    const signal = AbortSignal.timeout(20_000);
    for (;;) {
      if (service.exitCode !== null) {
        await once(child.stderr, 'close');
        throw new Error(`the service process exited ${service.exitCode}: ${serviceErr.text()}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal }).catch(() => null);
      if (response) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8'))).toMatchObject({ pid: stimd.pid, netPort: port });
    expect(service.exitCode).toBeNull();
    expect(stimdErr.text()).not.toContain('STIM_TEST_SERVICE_ONLY has no value');
    await expect(fetch(`http://127.0.0.1:${shared.port}/health`)).rejects.toThrow('fetch failed');

    expect(await desktopEnsure(socket, { port: 0, loopbackOnly: true })).toMatchObject({ listening: true, port });

    const serviceExited = once(service, 'exit');
    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
    await serviceExited;
  } finally {
    for (const child of [stimd, service])
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

test("an ask that arrives while a service's ask moves the net thread gets the service's thread (flaky under load, see #5864)", async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-bystander-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket, build } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const first = { kind: 'cli', build };
    expect(await ensureAs(socket, first, { share: true })).toMatchObject({ listening: true });
    const port = await freePort();
    const ask = { port, loopbackOnly: false, extraEnv: [], pathPrepend: [], service: true };
    const moving = ensureAs(socket, first, ask);
    await new Promise((done) => setTimeout(done, 5));
    const bystander = ensureAs(socket, first, { port, loopbackOnly: true });
    const [moved, bystood] = await Promise.all([moving, bystander]);
    expect(moved).toMatchObject({ listening: true, port });
    expect(bystood).toMatchObject({ listening: true });
    const restarts = () =>
      readFileSync(daemonNdjsonFile(), 'utf8')
        .split('\n')
        .filter((line) => line.includes('"net_restart"')).length;
    const flushed = () => new Promise((done) => setTimeout(done, 1000));
    await flushed();
    const before = restarts();
    expect(await ensureAs(socket, first, ask)).toMatchObject({ listening: true, port });
    await flushed();
    expect(restarts()).toBe(before);

    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("a Desktop ask that arrives while the service's thread starts does not replace it", async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-service-start-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket, build } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const port = await freePort();
    const starting = ensureAs(
      socket,
      { kind: 'cli', build },
      { port, loopbackOnly: false, extraEnv: [], pathPrepend: [], service: true },
    );
    await new Promise((done) => setTimeout(done, 5));
    const desktop = ensureAs(socket, { kind: 'desktop' }, { port: 0, loopbackOnly: true });
    expect(await starting).toMatchObject({ listening: true, port });
    expect(await desktop).toMatchObject({ listening: true, port });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBeLessThan(600);
    expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8'))).toMatchObject({ netPort: port });

    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('a service move that cannot bind the service port leaves the share-only thread serving and retries later (flaky under load, see #5864)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-service-held-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  const holder = createServer();
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket, build } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const first = { kind: 'cli', build };
    expect(await ensureAs(socket, first, { share: true })).toMatchObject({ listening: true });
    holder.listen(0, '127.0.0.1');
    await once(holder, 'listening');
    const address = holder.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    const ask = { port, loopbackOnly: false, extraEnv: [], pathPrepend: [], service: true };

    expect(await ensureAs(socket, first, ask)).toMatchObject({ listening: false });
    const record = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    expect(record.netPort).toEqual(expect.any(Number));
    expect(record.netPort).not.toBe(port);
    expect((await fetch(`http://127.0.0.1:${record.netPort}/health`)).status).toBeLessThan(600);

    holder.close();
    await once(holder, 'close');
    expect(await ensureAs(socket, first, ask)).toMatchObject({ listening: true, port });

    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    holder.close();
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('two overlapping service asks against a held service port restore the shares and a later ask moves the thread (flaky under load, see #5864)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-service-overlap-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  const holder = createServer();
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket, build } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    const first = { kind: 'cli', build };
    expect(await ensureAs(socket, first, { share: true })).toMatchObject({ listening: true });
    holder.listen(0, '127.0.0.1');
    await once(holder, 'listening');
    const address = holder.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    const ask = { port, loopbackOnly: false, extraEnv: [], pathPrepend: [], service: true };

    const second = { kind: 'cli', build };
    const moving = ensureAs(socket, first, ask);
    await new Promise((done) => setTimeout(done, 5));
    const overlapping = ensureAs(socket, second, ask);
    const [moved, overlapped] = await Promise.all([moving, overlapping]);
    expect(moved).toMatchObject({ listening: false });
    expect(overlapped).toMatchObject({ listening: false });
    const record = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    expect(record.netPort).toEqual(expect.any(Number));
    expect(record.netPort).not.toBe(port);
    expect((await fetch(`http://127.0.0.1:${record.netPort}/health`)).status).toBeLessThan(600);

    holder.close();
    await once(holder, 'close');
    expect(await ensureAs(socket, first, ask)).toMatchObject({ listening: true, port });

    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    holder.close();
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

test('a service ask for port 0 moves the share-only thread and keeps its listener and ownership', async () => {
  await withStimd('port-zero', async ({ socket, build }) => {
    const cli = { kind: 'cli', build };
    expect(await ensureAs(socket, cli, { share: true })).toMatchObject({ listening: true });
    const answer = await ensureAs(socket, cli, {
      port: 0,
      loopbackOnly: true,
      extraEnv: [],
      pathPrepend: [],
      service: true,
    });
    expect(answer).toMatchObject({ listening: true });
    const port = Number(answer.port);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBeLessThan(600);
    const desktop = await ensureAs(socket, { kind: 'desktop' }, { port: await freePort(), loopbackOnly: true });
    expect(desktop).toMatchObject({ listening: true, port });
  });
}, 120_000);

test.each([
  ['without Desktop input', {}],
  ['with a Desktop lifetime pipe on stdin', { STIM_DESKTOP_LIFETIME_FD: '0' }],
])(
  'stim serve refused on a held port by a running stimd exits 1, not by a signal, %s',
  async (_name, extra) => {
    await withStimd('serve-held', async ({ holdPort, stimdExited }) => {
      const port = await holdPort();
      const home = process.env.STIM_HOME;
      type Outcome = { code: number; signal: string | null; stderr: string };
      const finished: Outcome = { code: 0, signal: null, stderr: '' };
      const run = await execute(
        process.execPath,
        [join(root, 'packages/stim-cli/dist/cli.mjs'), 'serve', '--port', String(port), '--loopback-only'],
        {
          env: { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '', ...extra },
          timeout: 30_000,
        },
      ).then(
        () => finished,
        (error: Outcome) => error,
      );
      expect(run).toMatchObject({ code: 1, signal: null });
      expect(run.stderr).toContain(`port ${port} is `);
      await Promise.race([stimdExited, new Promise((done) => setTimeout(done, 5000))]);
    });
  },
  60_000,
);

test('stim serve stopped while its net thread starts exits 0 (flaky under load, see #5864)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-serve-stop-start-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const serve = spawn(
    process.execPath,
    [join(root, 'packages/stim-cli/bin/stim.mjs'), 'serve', '--port', '0', '--loopback-only'],
    { env, stdio: 'ignore' },
  );
  const exited = once(serve, 'exit');
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || serve.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 2));
    }
    serve.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  } finally {
    if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('a service ask that lands while stim serve --share starts its thread gets an answer and leaves stim serve running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-serve-share-boot-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const serve = spawn(
    process.execPath,
    [join(root, 'packages/stim-cli/bin/stim.mjs'), 'serve', '--share', '--port', '0'],
    {
      env,
      stdio: 'ignore',
    },
  );
  try {
    let record: { socket: string; build: string } | undefined;
    const deadline = Date.now() + 30_000;
    while (!record) {
      if (Date.now() > deadline || serve.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      try {
        record = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
      } catch {
        await new Promise((done) => setTimeout(done, 2));
      }
    }
    const port = await freePort();
    const answer = await ensureAs(record.socket, { kind: 'cli', build: record.build }, serviceAsk(port));
    expect(answer).toMatchObject({ listening: true, port });
    expect(serve.exitCode).toBeNull();
  } finally {
    if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('a matching service ask that lands while the booted thread starts joins it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-net-boot-window-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const port = await freePort();
  const stimd = spawn(
    process.execPath,
    [
      join(root, 'packages/stim-cli/dist/cli.mjs'),
      '__stimd',
      '--mode',
      'off',
      '--carried',
      '--service',
      '--loopback-only',
      '--port',
      String(port),
    ],
    { env, stdio: 'ignore' },
  );
  const stimdExited = once(stimd, 'exit');
  try {
    let record: { socket: string; build: string } | undefined;
    const deadline = Date.now() + 15_000;
    while (!record) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      try {
        record = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
      } catch {
        await new Promise((done) => setTimeout(done, 2));
      }
    }
    const ask = { port, loopbackOnly: true, extraEnv: [], pathPrepend: [], service: true };
    expect(await ensureAs(record.socket, { kind: 'cli', build: record.build }, ask)).toMatchObject({
      listening: true,
      port,
    });
    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

async function withStimd(
  name: string,
  body: (context: {
    socket: string;
    build: string;
    holdPort: () => Promise<number>;
    releasePort: () => Promise<void>;
    stimdExited: Promise<unknown>;
  }) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), `stim-net-${name}-`));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const stimd = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  const stimdExited = once(stimd, 'exit');
  const holder = createServer();
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(stimdRecordFile())) {
      if (Date.now() > deadline || stimd.exitCode !== null) throw new Error('stimd wrote no run/stimd.json');
      await new Promise((done) => setTimeout(done, 50));
    }
    const { socket, build } = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    await body({
      socket,
      build,
      stimdExited,
      holdPort: async () => {
        holder.listen(0, '127.0.0.1');
        await once(holder, 'listening');
        const address = holder.address();
        assert.ok(address && typeof address === 'object');
        return address.port;
      },
      releasePort: async () => {
        holder.close();
        await once(holder, 'close');
      },
    });
    stimd.kill('SIGTERM');
    expect(await stimdExited).toEqual([0, null]);
  } finally {
    holder.close();
    if (stimd.exitCode === null && stimd.signalCode === null) stimd.kill('SIGKILL');
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function logged(text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(daemonNdjsonFile()) || !readFileSync(daemonNdjsonFile(), 'utf8').includes(text)) {
    if (Date.now() > deadline) throw new Error(`stimd never logged ${text}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const serviceAsk = (port: number) => ({ port, loopbackOnly: false, extraEnv: [], pathPrepend: [], service: true });

test('a Desktop ask sent as a service move starts waits for the rollback and then gets its own port (flaky under load, see #5864)', async () => {
  await withStimd('queue-desktop', async ({ socket, build, holdPort }) => {
    const cli = { kind: 'cli', build };
    expect(await ensureAs(socket, cli, { share: true })).toMatchObject({ listening: true });
    const held = await holdPort();
    const desktopPort = await freePort();
    const moving = ensureAs(socket, cli, serviceAsk(held));
    await logged('"net_restart"');
    const desktop = ensureAs(socket, { kind: 'desktop' }, { port: desktopPort, loopbackOnly: true });
    const [moved, desktopAnswer] = await Promise.all([moving, desktop]);
    expect(moved).toMatchObject({ listening: false });
    expect(desktopAnswer).toMatchObject({ listening: true, port: desktopPort });
    expect((await fetch(`http://127.0.0.1:${desktopPort}/health`)).status).toBeLessThan(600);
  });
}, 120_000);

test('a service ask sent during a Desktop restart is refused and leaves the thread to Desktop (flaky under load, see #5864)', async () => {
  await withStimd('queue-restart', async ({ socket, build, holdPort }) => {
    const cli = { kind: 'cli', build };
    expect(await ensureAs(socket, cli, { share: true })).toMatchObject({ listening: true });
    const held = await holdPort();
    const desktopPort = await freePort();
    const restarting = ensureAs(socket, { kind: 'desktop' }, { port: desktopPort, loopbackOnly: true });
    await logged('Stim Desktop asked for other net thread options');
    const service = ensureAs(socket, cli, serviceAsk(held));
    const [restarted, serviced] = await Promise.all([restarting, service]);
    expect(restarted).toMatchObject({ listening: true, port: desktopPort });
    expect(serviced).toMatchObject({ listening: false });
    const otherPort = await freePort();
    expect(await ensureAs(socket, { kind: 'desktop' }, { port: otherPort, loopbackOnly: true })).toMatchObject({
      listening: true,
      port: otherPort,
    });
  });
}, 120_000);

test('a service ask for Desktop loopback thread on the same port is refused and Desktop can still move it (flaky under load, see #5864)', async () => {
  await withStimd('queue-mismatch', async ({ socket, build }) => {
    const port = await freePort();
    expect(await ensureAs(socket, { kind: 'desktop' }, { port, loopbackOnly: true })).toMatchObject({
      listening: true,
      port,
    });
    expect(await ensureAs(socket, { kind: 'cli', build }, serviceAsk(port))).toMatchObject({ listening: false });
    const otherPort = await freePort();
    expect(await ensureAs(socket, { kind: 'desktop' }, { port: otherPort, loopbackOnly: true })).toMatchObject({
      listening: true,
      port: otherPort,
    });
  });
}, 120_000);
