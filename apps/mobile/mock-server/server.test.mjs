import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { initiateNoise } from '@stim-cli/core/noise-session';
import { isRpcResult } from '@stim-cli/core/receive-protocol';
import { WebSocket } from 'ws';

test('advertises the phone API in hello', { timeout: 10_000 }, async (t) => {
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
  const reply = once(socket, 'message');
  socket.send(JSON.stringify({ id: 1, method: 'hello', params: {} }));
  const [data] = await reply;
  const { result } = JSON.parse(data.toString());
  assert.equal(result.phoneApi, 2);
  assert.ok(isRpcResult('hello', result));
  assert.deepEqual(result.features, [
    'ios-hosted',
    'android-hosted',
    'physical-ios',
    'physical-android',
    'notifications',
    'workspace-diff',
    'device-clipboard',
  ]);
});
