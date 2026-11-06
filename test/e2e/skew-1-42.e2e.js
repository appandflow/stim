import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { generateNoiseKeyPair } from '../../packages/core/noise.ts';
import { acceptNoise, newSecret, secretValues } from '../../packages/core/noise-session.ts';
import { DESKTOP_API, PEER, PHONE_API } from '../../packages/core/protocol.ts';
import { rpcResultIssue } from '../../packages/core/receive-protocol.ts';
import { serverLocalSocket } from '../../packages/core/state/paths.ts';
import {
  localConnect,
  noiseConnect,
  setupClient,
  terminateClients,
} from '../../packages/server/__tests__/noise-client.ts';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const stim = join(root, 'packages/stim-cli/bin/stim.mjs');
const version = JSON.parse(readFileSync(join(root, 'packages/stim-cli/package.json'), 'utf8')).version;
const { WebSocketServer } = createRequire(join(root, 'packages/server/package.json'))('ws');

const TURNED_AWAY_1_41 = new Set(['unauthorized', 'forbidden', 'protocol-unsupported', 'server-key-mismatch']);
const REFUSED = { code: 4401, reason: 'protocol-unsupported' };

const home = mkdtempSync(join(tmpdir(), 'stim-skew-'));
const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home, PATH: '' };
let server;
let exited;
let port;
let machine;

before(async () => {
  process.env.STIM_HOME = home;
  server = spawn(process.execPath, [stim, 'serve', '--loopback-only', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(server, 'exit');
  let output = '';
  let errors = '';
  server.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  port = await new Promise((done, fail) => {
    server.once('error', fail);
    server.once('exit', () => fail(new Error(`stim serve exited before listening:\n${output}\n${errors}`)));
    server.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) done(Number(match[1]));
    });
  });
  const signal = AbortSignal.timeout(20_000);
  let response;
  do response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
  while (response.status === 503);
  assert.equal(response.status, 200, errors);
  machine = (await response.json()).name;
});

after(async () => {
  terminateClients();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await exited;
  }
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const url = () => `ws://127.0.0.1:${port}`;

/** A single-use pairing token from the real `stim pair`, as a person shows it to a phone or to Stim Desktop. */
async function pairingToken() {
  const { stdout } = await execFileAsync(process.execPath, [stim, 'pair', '--json', '--port', String(port)], { env });
  return JSON.parse(stdout).qr.pairingToken;
}

/** First contact over Noise with a fresh pairing token, then `hello` as `client`. */
async function pairedHello(client) {
  const connection = await noiseConnect(url(), { secret: await pairingToken(), name: 'Skew client' });
  return { connection, reply: await connection.request('hello', { client }) };
}

async function assertRefused({ connection, reply }, remedy) {
  assert.equal(reply.error?.code, 'protocol-unsupported', JSON.stringify(reply));
  assert.ok(reply.error.message.endsWith(remedy), reply.error.message);
  assert.deepEqual(await connection.closedWith, REFUSED);
}

/**
 * 1.41's `readWebShares` (`packages/stim-cli/src/local-server.ts`): `hello` without any wire integer, then
 * `share.list`, on this home's local socket; `unknown-method` means a server before shares, any other error is
 * unreadable.
 */
async function readWebShares141() {
  const connection = await localConnect(serverLocalSocket());
  try {
    let answer = await connection.request('hello', { client: { name: 'stim', version: 'stim' } });
    if (!answer.error) answer = await connection.request('share.list', {});
    if (answer.error) return answer.error.code === 'unknown-method' ? null : { unreadable: answer.error.message };
    return Array.isArray(answer.result?.shares)
      ? answer.result.shares
      : { unreadable: 'stim-server sent no share list' };
  } finally {
    connection.socket.terminate();
  }
}

test('a 1.41 CLI offloading over Noise is turned away with peer-too-old and the update remedy', async () => {
  const { keyPair } = setupClient(['build'], 'Laptop');
  const cli = await noiseConnect(url(), { keyPair });
  const reply = await cli.request('hello', {
    client: { name: 'stim', version: '1', runId: 'skew-1-41-cli' },
    access: 'build',
  });
  assert.equal(reply.error?.code, 'protocol-unsupported', JSON.stringify(reply));
  assert.ok(TURNED_AWAY_1_41.has(reply.error.code), '1.41 falls back to a local build only for a refusal');
  const printed = `mac-mini: ${reply.error.message}`;
  assert.ok(
    printed.startsWith(
      `mac-mini: peer-too-old: ${machine} runs stim ${version} (peer ${PEER}); this stim sends no peer;`,
    ),
    printed,
  );
  assert.ok(printed.includes(`npm i -g stim@${version}`), printed);
  assert.ok(printed.includes('stim service install'), printed);
  assert.deepEqual(await cli.closedWith, REFUSED);

  const current = await noiseConnect(url(), { keyPair });
  const accepted = await current.request('hello', {
    client: { name: 'stim', version, runId: 'skew-1-42-cli', peer: PEER },
    access: 'build',
  });
  assert.equal(accepted.result?.peer, PEER, JSON.stringify(accepted));
  assert.ok(accepted.result.capabilities.includes('build'));
  current.socket.close();
});

test('a 1.41 readWebShares on the 1.42 local socket reads the share list, never unreadable', async () => {
  assert.deepEqual(await readWebShares141(), []);
});

test('a phone hello without phoneApi is refused with protocol-unsupported and the App Store remedy', async () => {
  await assertRefused(
    await pairedHello({ name: 'stim-mobile', version: '0.9.0' }),
    'Update Stim Mobile from the App Store or TestFlight.',
  );
});

test('a Stim Desktop hello without desktopApi is refused over Noise and answered on the local socket', async () => {
  const desktop = { name: 'Stim Desktop', version: '0.9.0' };
  await assertRefused(await pairedHello(desktop), 'Update Stim Desktop (Stim > Check for Updates).');

  const local = await localConnect(serverLocalSocket());
  try {
    const reply = await local.request('hello', { client: desktop });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.desktopApi, DESKTOP_API);
    assert.equal('features' in reply.result, false);
  } finally {
    local.socket.terminate();
  }
});

/** What a 1.41 stim-server answers `hello` with: `features` and no wire integers; `host` only under Stim Host. */
function hello141(host) {
  return {
    ...(host === undefined ? {} : { host }),
    protocol: 2,
    server: { name: 'mac-mini', version: '1.41.0', stim: '1.41.0', home: '/Users/me', id: 'home-1-41' },
    capabilities: ['read'],
    features: ['physical-ios', 'physical-android', 'notifications', 'device-frames'],
    actions: [],
    device: { id: 'phone-1', name: 'iPhone' },
  };
}

test('a 1.42 phone parses a 1.41 server hello, which carries no phoneApi', async () => {
  const token = newSecret();
  const { lookup, psk } = secretValues(Buffer.from(token, 'base64url'));
  const keyPair = generateNoiseKeyPair();
  const old = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(old, 'listening');
  let host;
  old.on('connection', (raw) =>
    raw.once('message', async (data, isBinary) => {
      const { socket } = await acceptNoise(raw, data, isBinary, {
        keyPair,
        psk: (asked) => (asked === lookup.toString('hex') ? psk : null),
        timeoutMs: 5000,
      });
      socket.on('message', (text) => {
        const { id } = JSON.parse(String(text));
        socket.send(JSON.stringify({ id, result: hello141(host) }));
      });
    }),
  );
  try {
    for (host of [undefined, null, { name: 'Stim Host', screenRecording: true, accessibility: false }]) {
      const phone = await noiseConnect(`ws://127.0.0.1:${old.address().port}`, { secret: token, name: 'iPhone' });
      const reply = await phone.request('hello', {
        client: { name: 'stim-mobile', version: '1.42.0', phoneApi: PHONE_API },
      });
      phone.socket.close();
      assert.equal(rpcResultIssue('hello', reply.result), null, JSON.stringify(reply));
      assert.equal(reply.result.phoneApi, undefined);
      assert.equal(host?.owner, undefined);
    }
  } finally {
    for (const client of old.clients) client.terminate();
    old.close();
  }
});
