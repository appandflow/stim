import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DESKTOP_API, PHONE_API } from '@stim-cli/core/protocol';
import { desktopKeyFile, isJsonObject, stimBuildDigest, stimdRecordFile } from '@stim-cli/core/state';
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
