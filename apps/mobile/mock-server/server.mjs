#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

import { filterRecords, loadFixtures, shiftTimestamps, usageHistory } from './fixtures.mjs';
import { loadRecording, replayRange, VideoFeed } from './replay.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7787' },
    name: { type: 'string', default: 'Mock Mac' },
    read: { type: 'boolean', default: false },
    workspaces: { type: 'string' },
    'free-gb': { type: 'string', default: '212' },
    overlay: { type: 'string' },
  },
});

const PAIRING_TTL_MS = 5 * 60 * 1000;
const TOKENS_FILE = join(tmpdir(), 'stim-mobile-mock-server-tokens.json');
const fixtures = loadFixtures();
const recording = loadRecording();
let recordingEnabled = true;
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
const shiftMs = startedAt - Date.parse(fixtures.capturedAt);
const logs = fixtures.logs.map((record) => ({ ...record, ts: record.ts + shiftMs }));
const only = values.workspaces ? new RegExp(values.workspaces) : null;
const readOverlay = () => {
  if (!values.overlay) return {};
  try {
    return JSON.parse(readFileSync(values.overlay, 'utf8'));
  } catch {
    return {};
  }
};
const overlaid = (payload) => {
  const changes = readOverlay().environments ?? {};
  return {
    ...payload,
    environments: payload.environments.map((env) => ({
      ...env,
      recording: { enabled: recordingEnabled },
      ...changes[env.path],
    })),
  };
};
const status = () => {
  const payload = overlaid(shiftTimestamps(fixtures.status, shiftMs));
  if (!only) return payload;
  const environments = payload.environments.filter((env) => only.test(env.path));
  const live = environments.filter((env) => env.live);
  return {
    ...payload,
    environments,
    capacity: {
      ...payload.capacity,
      liveCount: live.length,
      committedMb: live.reduce((sum, env) => sum + env.memoryMb, 0),
    },
  };
};
const NOTIFICATION_LOG = `mock-${randomBytes(4).toString('hex')}`;
const MINUTE = 60_000;
const notificationSamples = (() => {
  const login = '/Users/dev/Developer/tlon-apps/.worktrees/web-login';
  const hinges = '/Users/dev/Developer/react-native-hinges/example';
  const pr = 'https://github.com/appandflow/react-native-hinges/pull/42';
  return [
    {
      ago: 2,
      id: `stuck:${login}`,
      category: 'stuck',
      title: 'web-login',
      body: 'No agent activity for 15 min; iPhone 17 Pro 26.0 still up',
      target: { kind: 'device', path: login, platform: 'ios', slot: 'default' },
    },
    {
      ago: 18,
      id: `started:${login}`,
      category: 'started',
      title: 'web-login',
      body: `agent-device started driving iPhone 17 Pro 26.0 on ${values.name}`,
      quiet: true,
      target: { kind: 'device', path: login, platform: 'ios', slot: 'default' },
    },
    {
      ago: 47,
      id: `looping-android:${hinges}`,
      category: 'looping',
      title: 'example',
      body: 'Same Kotlin error 3x at MainActivity.kt:42',
      target: { kind: 'build', path: hinges, platform: 'android' },
    },
    {
      ago: 95,
      id: `finished:${hinges}`,
      category: 'finished',
      title: 'example',
      body: 'PR #42 is ready for review',
      target: { kind: 'url', path: hinges, url: pr },
    },
    {
      ago: 60 * 20,
      id: 'machine:disk',
      category: 'machine',
      title: values.name,
      body: "4.2 GB free, below Stim's floor",
      target: { kind: 'machine' },
      suppressed: 'quiet-hours',
    },
    {
      ago: 60 * 26,
      id: `control:${login}:ios:default`,
      category: 'control',
      title: 'web-login',
      body: 'iPad took over the iOS device you were controlling',
      target: { kind: 'device', path: login, platform: 'ios', slot: 'default' },
    },
    {
      ago: 60 * 30,
      id: `finished:${login}`,
      category: 'finished',
      title: 'web-login',
      body: 'Agent stopped after a green iOS build',
      target: { kind: 'workspace', path: login },
      suppressed: 'muted',
    },
    {
      ago: 60 * 50,
      id: `started:${hinges}`,
      category: 'started',
      title: 'example',
      body: `Warming on ${values.name}`,
      quiet: true,
      target: { kind: 'workspace', path: hinges },
    },
  ];
})();
const notifications = notificationSamples
  .toReversed()
  .map(({ ago, quiet = true, ...rest }, i) => ({
    seq: i + 1,
    at: new Date(startedAt - ago * MINUTE).toISOString(),
    quiet,
    ...rest,
  }))
  .toReversed();
const notificationListeners = new Set();
const LIVE_NOTIFICATION_MS = 120_000;
setInterval(() => {
  const sample = notificationSamples[notifications.length % notificationSamples.length];
  const { ago: _ago, quiet = true, ...rest } = sample;
  const entry = { seq: notifications[0].seq + 1, at: new Date().toISOString(), quiet, ...rest };
  delete entry.suppressed;
  notifications.unshift(entry);
  for (const send of notificationListeners) send({ event: 'notification', log: NOTIFICATION_LOG, notification: entry });
}, LIVE_NOTIFICATION_MS);

const GB = 1e9;
const usage = () => ({
  volumes: [
    {
      mount: '/',
      holds: ['Workspaces', 'Stim home', 'Simulators'],
      freeBytes: Number(readOverlay().freeGb ?? values['free-gb']) * GB,
      totalBytes: 994.66 * GB,
    },
  ],
  memory: {
    totalBytes: fixtures.status.capacity.totalMemoryMb * 1024 * 1024,
    usedBytes: 31.4 * 2 ** 30,
    pressure: 'normal',
  },
  load: { avg1: 6.2, avg5: 5.4, avg15: 4.9, cpus: 14 },
  cpu: { usage: 0.34, cores: 14 },
  sampledAt: new Date().toISOString(),
});

const HISTORY_INTERVAL_MS = 5000;
const history = (sinceMs = -Infinity) => {
  const end = Math.floor(Date.now() / HISTORY_INTERVAL_MS) * HISTORY_INTERVAL_MS;
  const samples = [];
  for (let at = end - 719 * HISTORY_INTERVAL_MS; at <= end; at += HISTORY_INTERVAL_MS) {
    if (at <= sinceMs) continue;
    const phase = at / 600_000;
    samples.push({
      at,
      cpu: 0.3 + 0.25 * Math.sin(phase * 2 * Math.PI) ** 2,
      memoryUsedBytes: (29 + 3 * Math.sin(phase)) * 2 ** 30,
      memoryPressure: 0,
      diskFreeBytes: Number(values['free-gb']) * GB,
    });
  }
  return { intervalMs: HISTORY_INTERVAL_MS, samples };
};

server.on('connection', (socket) => {
  let authed = false;
  let nextSubscription = 1;
  const timers = new Map();
  const send = (message) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const feeds = new Map();
  const stop = (subscription) => {
    clearInterval(timers.get(subscription));
    timers.delete(subscription);
    feeds.get(subscription)?.stop();
    feeds.delete(subscription);
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
        return { result: hello(auth.deviceToken, 'Phone') };
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
      return { result: { ...hello(deviceToken, auth.deviceName ?? 'Phone'), deviceToken } };
    },
    'status.subscribe'() {
      const event = (id) => {
        const payload = status();
        return {
          event: 'status',
          subscription: id,
          payload,
          usage: usageHistory(payload.machine?.owners ?? [], Date.now()),
        };
      };
      const subscription = every(5000, (id) => send(event(id)));
      setImmediate(() => send(event(subscription)));
      return { result: { subscription } };
    },
    'logs.query'(params) {
      return { result: { records: filterRecords(logs, params) } };
    },
    'logs.subscribe'(params) {
      let cursor = 0;
      const subscription = every(2000, (id) => {
        const record = { ...logs[cursor++ % logs.length], ts: Date.now() };
        const records = filterRecords([record], { ...params, tail: undefined });
        if (records.length > 0) send({ event: 'logs', subscription: id, records });
      });
      setImmediate(() => send({ event: 'logs', subscription, records: filterRecords(logs, params) }));
      return { result: { subscription } };
    },
    'frames.subscribe'(params) {
      if (params.platform === 'ios' && params.video?.includes('h264')) {
        const subscription = `s${nextSubscription++}`;
        const feed = new VideoFeed(recording, subscription, socket, send);
        feeds.set(subscription, feed);
        if (params.at === undefined) setImmediate(() => feed.live());
        else setImmediate(() => feed.seek(params.at, params.rate ?? 0));
        return { result: { subscription, video: 'h264' } };
      }
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
    'build.plan'(params) {
      const plan = fixtures.plans[params.platform];
      if (!plan) return { error: ['stim-failed', `The mock server has no ${params.platform} plan fixture.`] };
      return { result: { ...plan, ...(params.slot && params.slot !== 'default' ? { slot: params.slot } : {}) } };
    },
    'settings.get'() {
      return {
        result: {
          project: null,
          files: {},
          settings: [{ key: 'recording.enabled', value: recordingEnabled, origin: 'machine', layers: {} }],
          unknown: [],
        },
      };
    },
    'replay.range'(params) {
      if (params.platform !== 'ios' || !recordingEnabled) {
        return { result: { enabled: recordingEnabled, recording: false, spans: [], markers: [] } };
      }
      return { result: replayRange(recording) };
    },
    'frames.seek'(params) {
      const feed = feeds.get(params.subscription);
      if (!feed) return { error: ['unknown-subscription', `No video subscription ${params.subscription}.`] };
      return { result: { at: feed.seek(params.at, params.rate) } };
    },
    'frames.live'(params) {
      const feed = feeds.get(params.subscription);
      if (!feed) return { error: ['unknown-subscription', `No video subscription ${params.subscription}.`] };
      feed.live();
      return { result: {} };
    },
    'frames.keyframe'() {
      return { result: {} };
    },
    'recording.set'(params) {
      if (values.read) return { error: ['forbidden', 'This device can only read (mock server started with --read).'] };
      recordingEnabled = params.enabled === true;
      return { result: { enabled: recordingEnabled, recordingsDeleted: [] } };
    },
    action(params, id) {
      if (values.read) return { error: ['forbidden', 'This device can only read (mock server started with --read).'] };
      if (!ACTIONS.includes(params.action)) return { error: ['unknown-action', `Unknown action ${params.action}.`] };
      const platformOk =
        params.platform === undefined ||
        (params.action === 'reload' && ['ios', 'android', 'web'].includes(params.platform));
      if (!platformOk) return { error: ['bad-request', 'platform must be ios, android or web, and only for reload.'] };
      const env = fixtures.status.environments.find((candidate) => candidate.path === params.workspace);
      if (!env) return { error: ['unknown-workspace', `${params.workspace} is not a Stim workspace on this Mac.`] };
      if (params.action === 'reload' && params.platform === undefined && runsBothPlatforms(env)) {
        return {
          error: [
            'action-failed',
            'STIM_RELOAD_AMBIGUOUS: Both the iOS and Android apps are running. Choose one with `stim reload ios` or `stim reload android`.',
          ],
        };
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
    'machine.get'() {
      return { result: usage() };
    },
    'machine.details'() {
      return { result: shiftTimestamps(fixtures.machineDetails, shiftMs) };
    },
    'machine.history'(params) {
      return { result: history(params.sinceMs) };
    },
    'notifications.list'(params) {
      notificationListeners.add(send);
      const since = params.since ?? 0;
      return {
        result: {
          log: NOTIFICATION_LOG,
          cursor: notifications[0].seq,
          notifications: notifications.filter((entry) => entry.seq > since),
        },
      };
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
    notificationListeners.delete(send);
    for (const subscription of new Set([...timers.keys(), ...feeds.keys()])) stop(subscription);
  });
});

function runsBothPlatforms(env) {
  const slots = [env, ...(env.slots ?? [])];
  return slots.some((slot) => slot.ios?.state === 'Booted') && slots.some((slot) => slot.android?.state === 'detected');
}

function hello(deviceToken, deviceName) {
  return {
    protocol: 1,
    server: { name: values.name, version: '0.0.0-mock', stim: fixtures.stimVersion, home: fixtures.home },
    capabilities: values.read ? ['read'] : ['read', 'control'],
    features: ['physical-ios', 'physical-android', 'notifications'],
    actions: values.read ? [] : ACTIONS,
    device: { id: hash(deviceToken).slice(0, 8), name: deviceName },
  };
}
