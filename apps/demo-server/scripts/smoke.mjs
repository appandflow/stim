#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { noiseKeyPairFromPrivateKey } from '@stim-cli/core/noise';
import { decodeSecret, HandshakeRefusal, initiateNoise, keyFingerprint } from '@stim-cli/core/noise-session';
import { WebSocket } from 'ws';

const TOKEN_HINT =
  'DEMO_TOKEN must be 43 base64url characters (32 bytes), as the README openssl line produces; the demo server refuses every phone with any other value.';

/**
 * Checks a deployed demo server: its pairing code, a protocol 2 first contact with `token`, `hello`, and a first
 * status event. The client key is derived from the token, so every run pairs the same device record again instead of
 * adding one; anyone holding the token can pair a phone anyway. Throws an Error naming the failed check.
 */
export async function smoke(url, token, { attempts = 6, delayMs = 5000, timeoutMs = 10_000 } = {}) {
  const secret = decodeSecret(token ?? '');
  if (!secret) throw new Error(`DEMO_TOKEN is not a pairing token. ${TOKEN_HINT}`);
  const endpoint = url.replace(/^http/, 'ws').replace(/\/$/, '');

  let code;
  let last = 'no answer';
  for (let attempt = 1; attempt <= attempts && !code; attempt++) {
    if (attempt > 1) await sleep(delayMs);
    try {
      const response = await fetch(new URL('/pairing', url), { signal: AbortSignal.timeout(timeoutMs) });
      const body = response.ok ? await response.json() : null;
      if (body?.v === 2) code = body;
      else last = `HTTP ${response.status}${body ? `, v ${body.v}` : ''}`;
    } catch (error) {
      last = error.message;
    }
  }
  if (!code)
    throw new Error(`GET /pairing did not return a protocol 2 pairing code after ${attempts} tries (${last}).`);
  if (typeof code.name !== 'string' || code.name === '') throw new Error('The pairing code has no name.');
  if (code.endpoint !== endpoint) throw new Error(`The pairing code names ${code.endpoint}, not ${endpoint}.`);
  if (typeof code.fingerprint !== 'string' || code.fingerprint === '') {
    throw new Error('The pairing code has no fingerprint.');
  }

  const raw = new WebSocket(endpoint);
  try {
    await once(raw, 'open', { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    raw.terminate();
    throw new Error(`${endpoint} did not open a WebSocket: ${error.message}`, { cause: error });
  }
  let serverFingerprint;
  let socket;
  try {
    socket = await initiateNoise(raw, {
      keyPair: noiseKeyPairFromPrivateKey(
        createHash('sha256').update('stim demo smoke key v1').update(secret).digest(),
      ),
      secret,
      name: 'Deploy smoke test',
      acceptServerKey: (key) => (serverFingerprint = keyFingerprint(key)) === code.fingerprint,
      timeoutMs,
    });
  } catch (error) {
    if (serverFingerprint !== undefined && serverFingerprint !== code.fingerprint) {
      throw new Error(
        `The server key ${serverFingerprint} does not match the /pairing fingerprint ${code.fingerprint}.`,
        { cause: error },
      );
    }
    const hint = error instanceof HandshakeRefusal && error.code === 'unknown-secret' ? ` ${TOKEN_HINT}` : '';
    throw new Error(`First contact failed: ${error.message}${hint}`, { cause: error });
  }

  try {
    const received = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString('utf8'))));
    const next = async (match, what) => {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
        const found = received.find(match);
        if (found) return found;
        if (socket.readyState !== 1) throw new Error(`The socket closed while waiting for the ${what}.`);
      }
      throw new Error(`No ${what} within ${timeoutMs} ms.`);
    };
    socket.send(JSON.stringify({ id: 1, method: 'hello', params: {} }));
    const hello = await next((message) => message.id === 1, 'hello reply');
    if (hello.error) throw new Error(`hello failed: ${hello.error.code}, ${hello.error.message}`);
    if (hello.result?.protocol !== 2) throw new Error(`hello answered protocol ${hello.result?.protocol}, not 2.`);
    socket.send(JSON.stringify({ id: 2, method: 'status.subscribe', params: {} }));
    await next((message) => message.event === 'status', 'status event');
  } finally {
    socket.close(1000, 'done');
  }
  return { name: code.name, endpoint, fingerprint: code.fingerprint };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: DEMO_TOKEN=<token> node scripts/smoke.mjs <https url of the Worker>');
    process.exit(2);
  }
  try {
    const result = await smoke(url, process.env.DEMO_TOKEN);
    console.log(
      `Demo server smoke test passed: ${result.name} at ${result.endpoint}, fingerprint ${result.fingerprint}.`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`Demo server smoke test failed: ${error.message}`);
    process.exit(1);
  }
}
