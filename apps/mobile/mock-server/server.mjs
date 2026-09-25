#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

import { filterRecords, loadFixtures, shiftTimestamps } from './fixtures.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7787' },
    name: { type: 'string', default: 'Mock Mac' },
    read: { type: 'boolean', default: false },
  },
});

const PAIRING_TTL_MS = 5 * 60 * 1000;
const TOKENS_FILE = join(tmpdir(), 'stim-mobile-mock-server-tokens.json');
const fixtures = loadFixtures();
const hash = (token) => createHash('sha256').update(token).digest('hex');

let tokenHashes = new Set();
try {
  tokenHashes = new Set(JSON.parse(readFileSync(TOKENS_FILE, 'utf8')));
} catch {}

const endpoint = `ws://127.0.0.1:${values.port}`;
const PAIRING_FILE = join(tmpdir(), `stim-mobile-mock-server-pairing-${values.port}.json`);

function newPairing() {
  const next = { token: randomBytes(18).toString('base64url'), expiresAt: Date.now() + PAIRING_TTL_MS };
  const code = JSON.stringify({ v: 1, name: values.name, endpoint, pairingToken: next.token });
  writeFileSync(PAIRING_FILE, code);
  return { ...next, code };
}

let pairing = newPairing();
setInterval(() => {
  pairing = newPairing();
  console.log('Pairing code:');
  console.log(pairing.code);
}, PAIRING_TTL_MS);

const server = new WebSocketServer({ host: '127.0.0.1', port: Number(values.port) });
server.on('listening', () => {
  console.log(`Mock Stim server on ${endpoint}, replaying fixtures captured at ${fixtures.capturedAt}`);
  console.log('Pairing code (valid 5 minutes, single use):');
  console.log(pairing.code);
});

const ACTIONS = ['reload', 'stop'];
const ACTION_MS = 800;
const busy = new Set();

const startedAt = Date.now();
const status = () => shiftTimestamps(fixtures.status, startedAt - Date.parse(fixtures.capturedAt));

server.on('connection', (socket) => {
  let authed = false;
  let nextSubscription = 1;
  const timers = new Map();
  const send = (message) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const stop = (subscription) => {
    clearInterval(timers.get(subscription));
    timers.delete(subscription);
  };
  const every = (ms, fn) => {
    const subscription = `s${nextSubscription++}`;
    timers.set(
      subscription,
      setInterval(() => fn(subscription), ms),
    );
    return subscription;
  };

  const handlers = {
    hello(params) {
      if (params.protocol !== 1) return { error: ['protocol-unsupported', 'This server speaks protocol 1.'] };
      const auth = params.auth ?? {};
      if (typeof auth.deviceToken === 'string') {
        if (!tokenHashes.has(hash(auth.deviceToken))) {
          return { error: ['unauthorized', 'This Mac does not recognize this phone.'] };
        }
        authed = true;
        return { result: hello() };
      }
      if (auth.pairingToken !== pairing.token || Date.now() > pairing.expiresAt) {
        return { error: ['pairing-expired', 'This pairing code was used or expired. Show a new one in Stim Desktop.'] };
      }
      pairing = newPairing();
      const deviceToken = randomBytes(32).toString('base64url');
      tokenHashes.add(hash(deviceToken));
      writeFileSync(TOKENS_FILE, JSON.stringify([...tokenHashes]));
      console.log(`Paired ${auth.deviceName ?? 'a phone'}. Next pairing code:`);
      console.log(pairing.code);
      authed = true;
      return { result: { ...hello(), deviceToken } };
    },
    'status.subscribe'() {
      const subscription = every(5000, (id) => send({ event: 'status', subscription: id, payload: status() }));
      setImmediate(() => send({ event: 'status', subscription, payload: status() }));
      return { result: { subscription } };
    },
    'logs.query'(params) {
      return { result: { records: filterRecords(fixtures.logs, params) } };
    },
    'logs.subscribe'(params) {
      let cursor = 0;
      const subscription = every(2000, (id) => {
        const record = { ...fixtures.logs[cursor++ % fixtures.logs.length], ts: Date.now() };
        const records = filterRecords([record], { ...params, tail: undefined });
        if (records.length > 0) send({ event: 'logs', subscription: id, records });
      });
      setImmediate(() => send({ event: 'logs', subscription, records: filterRecords(fixtures.logs, params) }));
      return { result: { subscription } };
    },
    'frames.subscribe'(params) {
      const frame = fixtures.frames[params.platform];
      if (!frame) return { error: ['no-frames', `The mock server has no ${params.platform} frame fixture.`] };
      const subscription = every(1000, (id) =>
        send({
          event: 'frame',
          subscription: id,
          platform: params.platform,
          slot: params.slot ?? 'default',
          ...frame,
          capturedAt: new Date().toISOString(),
        }),
      );
      return { result: { subscription } };
    },
    'stats.get'() {
      return { error: ['not-implemented', 'The mock server does not serve stats.'] };
    },
    'settings.get'() {
      return { error: ['not-implemented', 'The mock server does not serve settings.'] };
    },
    action(params, id) {
      if (values.read) return { error: ['forbidden', 'This device can only read (mock server started with --read).'] };
      if (!ACTIONS.includes(params.action)) return { error: ['unknown-action', `Unknown action ${params.action}.`] };
      if (!fixtures.status.environments.some((env) => env.path === params.workspace)) {
        return { error: ['unknown-workspace', `${params.workspace} is not a Stim workspace on this Mac.`] };
      }
      if (busy.has(params.workspace)) {
        return { error: ['action-busy', `An action is already running in ${params.workspace}.`] };
      }
      busy.add(params.workspace);
      console.log(`${params.action} ${params.workspace}`);
      setTimeout(() => {
        busy.delete(params.workspace);
        send({ id, result: { action: params.action, workspace: params.workspace, output: { mock: true } } });
      }, ACTION_MS);
      return { deferred: true };
    },
    unsubscribe(params) {
      stop(params.subscription);
      return { result: {} };
    },
  };

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const { id, method, params = {} } = message;
    const handler = handlers[method];
    if (!handler) return fail(id, 'unknown-method', `Unknown method ${method}.`);
    if (method !== 'hello' && !authed) return fail(id, 'unauthorized', 'Send hello first.');
    let outcome;
    try {
      outcome = handler(params, id);
    } catch (error) {
      return fail(id, 'bad-request', error.message);
    }
    if (outcome.error) {
      fail(id, ...outcome.error);
      if (method === 'hello') socket.close();
      return;
    }
    if (!outcome.deferred) send({ id, result: outcome.result });
  });
  socket.on('close', () => {
    for (const subscription of timers.keys()) stop(subscription);
  });
});

function hello() {
  return {
    protocol: 1,
    server: { name: values.name, version: '0.0.0-mock', stim: fixtures.stimVersion },
    capabilities: values.read ? ['read'] : ['read', 'control'],
    actions: values.read ? [] : ACTIONS,
  };
}
