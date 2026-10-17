#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { noiseKeyPairFromPrivateKey } from '@stim-cli/core/noise';
import { decodeSecret, HandshakeRefusal, initiateNoise, keyFingerprint } from '@stim-cli/core/noise-session';
import { WebSocket } from 'ws';

/**
 * Checks a deployed demo server: its pairing code, a protocol 2 first contact with `token`, `hello`, and a first
 * status event. The client key is derived from the token, so every run pairs the same device record again instead of
 * adding one; anyone holding the token can pair a phone anyway. A deploy restarts the Worker, so a failed attempt is
 * retried within `windowMs`, every step bounded by what is left of it. With `version`, the Worker version that answers
 * `/pairing` must be that one. Throws an Error naming the last check that failed with its whole step timeout.
 *
 * @param {string} url
 * @param {string | undefined} token
 * @param {{ version?: string | undefined, windowMs?: number, delayMs?: number, timeoutMs?: number }} [options]
 */
export async function smoke(url, token, { version, windowMs = 60_000, delayMs = 5000, timeoutMs = 10_000 } = {}) {
  const secret = decodeSecret(token ?? '');
  if (!secret) {
    throw new Error(
      'DEMO_TOKEN is not a pairing token: it must be 43 base64url characters (32 bytes), as the README openssl line produces.',
    );
  }
  const endpoint = url.replace(/^http/, 'ws').replace(/\/$/, '');
  const deadline = Date.now() + windowMs;
  const stepMs = () => Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
  let telling;
  let tries = 0;
  for (;;) {
    tries++;
    const whole = deadline - Date.now() >= timeoutMs;
    try {
      return await check(url, endpoint, secret, version, stepMs);
    } catch (error) {
      if (whole || !telling) telling = error;
    }
    if (Date.now() + delayMs >= deadline) break;
    await sleep(delayMs);
  }
  throw new Error(`${telling.message} (after ${tries} tries in ${windowMs / 1000} s)`, { cause: telling });
}

async function check(url, endpoint, secret, version, stepMs) {
  const response = await fetch(new URL('/pairing', url), { signal: AbortSignal.timeout(stepMs()) });
  const code = response.ok ? await response.json() : null;
  const answering = response.headers.get('x-demo-version');
  if (version && answering !== version) {
    throw new Error(`The Worker answering is version ${answering ?? 'unknown'}, not the deployed ${version}.`);
  }
  if (code?.v !== 2) throw new Error(`GET /pairing returned no protocol 2 pairing code (HTTP ${response.status}).`);
  if (typeof code.name !== 'string' || code.name === '') throw new Error('The pairing code has no name.');
  if (code.endpoint !== endpoint) throw new Error(`The pairing code names ${code.endpoint}, not ${endpoint}.`);
  if (typeof code.fingerprint !== 'string' || code.fingerprint === '') {
    throw new Error('The pairing code has no fingerprint.');
  }

  const raw = new WebSocket(endpoint);
  try {
    await once(raw, 'open', { signal: AbortSignal.timeout(stepMs()) });
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
      timeoutMs: stepMs(),
    });
  } catch (error) {
    if (serverFingerprint !== undefined && serverFingerprint !== code.fingerprint) {
      throw new Error(
        `The server key ${serverFingerprint} does not match the /pairing fingerprint ${code.fingerprint}.`,
        { cause: error },
      );
    }
    const hint =
      error instanceof HandshakeRefusal && error.code === 'unknown-secret'
        ? ' The Worker does not hold this DEMO_TOKEN: the previous version may still be answering, or the secret upload failed.'
        : '';
    throw new Error(`First contact failed: ${error.message}${hint}`, { cause: error });
  }

  try {
    const received = [];
    let invalid = false;
    socket.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString('utf8')));
      } catch {
        invalid = true;
      }
    });
    const next = async (match, what) => {
      const waitMs = stepMs();
      for (const until = Date.now() + waitMs; Date.now() < until; await sleep(100)) {
        if (invalid) throw new Error(`The server sent a message that is not JSON while waiting for the ${what}.`);
        const found = received.find(match);
        if (found) return found;
        if (socket.readyState !== 1) throw new Error(`The socket closed while waiting for the ${what}.`);
      }
      throw new Error(`No ${what} within ${waitMs} ms.`);
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
  return { name: code.name, endpoint, fingerprint: code.fingerprint, version: answering };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: DEMO_TOKEN=<token> node scripts/smoke.mjs <https url of the Worker> [deployed version id]');
    process.exit(2);
  }
  try {
    const result = await smoke(url, process.env.DEMO_TOKEN, { version: process.argv[3] });
    console.log(
      `Demo server smoke test passed: ${result.name} at ${result.endpoint}, version ${result.version}, fingerprint ${result.fingerprint}.`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`Demo server smoke test failed: ${error.message}`);
    process.exit(1);
  }
}
