import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { initiateNoise } from '@stim-cli/core/noise-session';
import { isRpcError, isRpcEvent, isRpcResult } from '@stim-cli/core/receive-protocol';
import { WebSocket } from 'ws';

test('mock hello, RPCs and subscription events pass the phone receive validators', { timeout: 10_000 }, async (t) => {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const released = once(listener, 'close');
  listener.close();
  await released;

  const state = mkdtempSync(join(tmpdir(), 'stim-mock-hello-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--port', String(port)],
    {
      env: { ...process.env, STIM_HOME: state, TMPDIR: state, TMP: state, TEMP: state },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(state, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const pairing = await new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Mock server exited with ${code}: ${errors}`)));
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop();
      for (const line of lines) if (line.startsWith('{')) resolve(JSON.parse(line));
    });
  });
  const raw = new WebSocket(pairing.endpoint);
  t.after(() => raw.terminate());
  await once(raw, 'open');
  const socket = await initiateNoise(raw, {
    keyPair: generateNoiseKeyPair(),
    secret: Buffer.from(pairing.pairingToken, 'base64url'),
    acceptServerKey: () => true,
    name: 'Test phone',
    timeoutMs: 5_000,
  });
  const received = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString())));
  const waitFor = async (matches) => {
    const signal = AbortSignal.timeout(3_000);
    while (!received.some(matches)) await once(socket, 'message', { signal });
    return received.find(matches);
  };
  let nextId = 1;
  const request = async (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    const message = await waitFor((candidate) => candidate.id === id);
    assert.deepEqual(
      { method, ok: message.error ? isRpcError(message.error) : isRpcResult(method, message.result) },
      { method, ok: true },
    );
    return message;
  };
  const { result } = await request('hello');
  assert.equal(result.phoneApi, 2);
  assert.deepEqual(result.host, { owner: 'service', capabilities: result.host.capabilities, app: null });
  assert.deepEqual(result.features, [
    'ios-hosted',
    'android-hosted',
    'physical-ios',
    'physical-android',
    'notifications',
    'workspace-diff',
    'device-clipboard',
  ]);
  const status = JSON.parse(readFileSync(new URL('./fixtures/status.json', import.meta.url), 'utf8'));
  const workspace = status.payload.environments[0].path;
  const calls = [
    ['archived.list', {}],
    ['logs.query', { workspace, tail: 20 }],
    ['workspace.files', { workspace, group: 'tracked' }],
    ['workspace.diff', { workspace, path: 'src/app.tsx' }],
    ['build.plan', { workspace, platform: 'ios', slot: 'second' }],
    ['build.plan', { workspace, platform: 'android' }],
    ['settings.get', {}],
    ['recording.set', { enabled: true }],
    ['replay.range', { workspace, platform: 'ios' }],
    ['machine.get', {}],
    ['machine.history', {}],
    ['machine.details', {}],
    ['notifications.list', {}],
    ['frames.keyframe', {}],
    ['action', { workspace, action: 'reload', platform: 'ios' }],
  ];
  for (const [method, params] of calls) assert.notEqual((await request(method, params)).result, undefined, method);
  assert.ok((await request('stats.get')).error);
  for (const method of [
    'workspaces.subscribe',
    'workspace.subscribe',
    'machine.subscribe',
    'logs.subscribe',
    'frames.subscribe',
  ]) {
    const reply = await request(method, { workspace, platform: 'ios' });
    const subscription = reply.result.subscription;
    await waitFor((message) => message.subscription === subscription);
    for (const event of received.filter((message) => message.subscription === subscription)) {
      assert.deepEqual({ method, ok: isRpcEvent(event) }, { method, ok: true });
    }
    await request('unsubscribe', { subscription });
  }
});
