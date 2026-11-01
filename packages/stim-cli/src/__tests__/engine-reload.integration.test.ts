import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { reloadThroughMetro } from '../engine/reload.ts';

function peerServer(reply: (id: string | undefined) => unknown) {
  const messages: unknown[] = [];
  let sawReload!: () => void;
  const reloadSeen = new Promise<void>((resolve) => {
    sawReload = resolve;
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/message' });
  const listening = new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: string; method?: string };
      messages.push(message);
      if (message.method === 'getpeers') {
        const response = reply(message.id);
        if (response !== undefined) socket.send(JSON.stringify(response));
      }
      if (message.method === 'reload') sawReload();
    });
  });
  return { messages, reloadSeen, server, listening };
}

function peers(result: Record<string, unknown>) {
  return (id: string | undefined) => ({ version: 2, id, result });
}

async function withServer<T>(harness: ReturnType<typeof peerServer>, run: (port: number) => Promise<T>): Promise<T> {
  await harness.listening;
  const address = harness.server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  try {
    return await run(address.port);
  } finally {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
}

// Both peer-metadata shapes appear here deliberately: an object from
// @react-native-community/cli-server-api, a raw query string from @expo/cli.
const IOS_PEER = { role: 'ios' };
const IOS_PEER_RAW = 'role=ios';
const ANDROID_PEER = { device: 'sdk_gphone64', app: 'com.example.android', clientid: 'c1' };
const ANDROID_PEER_RAW = 'device=sdk_gphone64&app=com.example.android&clientid=c1';

test.each([
  ['object metadata', IOS_PEER],
  ['raw query metadata', IOS_PEER_RAW],
])('Metro reload targets the sole iOS peer with %s, leaving Android alone', async (_label, iosPeer) => {
  const harness = peerServer(peers({ 'client#1': iosPeer, 'client#2': ANDROID_PEER }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'ios', appId: 'com.example.ios' })).resolves.toEqual({
      ok: true,
      peers: 2,
      targets: 1,
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload', target: 'client#1' },
    ]);
  });
});

test('cancelling while Metro lists peers closes the socket without a late reload', async () => {
  let received!: () => void;
  let requestId: string | undefined;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  const harness = peerServer((id) => {
    requestId = id;
    received();
  });
  await withServer(harness, async (port) => {
    const controller = new AbortController();
    const pending = reloadThroughMetro(port, { role: 'ios', appId: 'com.example.ios', signal: controller.signal });
    await requested;
    const [socket] = harness.server.clients;
    if (!socket) throw new Error('Metro never accepted the client');
    const closed = once(socket, 'close');
    controller.abort();
    socket.send(JSON.stringify(peers({ 'client#1': IOS_PEER })(requestId)));
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    await closed;
    expect(harness.messages).toEqual([expect.objectContaining({ method: 'getpeers' })]);
  });
});

test('Metro closing before its peer reply settles even when cancellation follows the close', async () => {
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  const harness = peerServer(() => {
    received();
  });
  await withServer(harness, async (port) => {
    const controller = new AbortController();
    const pending = reloadThroughMetro(port, {
      role: 'ios',
      appId: 'com.example.ios',
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    await requested;
    const [socket] = harness.server.clients;
    if (!socket) throw new Error('Metro never accepted the client');
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    await delay(25);
    controller.abort();
    expect(await Promise.race([pending, delay(200, 'pending')])).toMatchObject({ failed: true, unreachable: true });
    expect(harness.messages).toEqual([expect.objectContaining({ method: 'getpeers' })]);
  });
});

test.each([
  ['object metadata', ANDROID_PEER],
  ['raw query metadata', ANDROID_PEER_RAW],
])('Metro reload targets the Android peer by package with %s, leaving iOS alone', async (_label, androidPeer) => {
  const harness = peerServer(peers({ 'client#1': IOS_PEER, 'client#2': androidPeer }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'android', appId: 'com.example.android' })).resolves.toEqual({
      ok: true,
      peers: 2,
      targets: 1,
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload', target: 'client#2' },
    ]);
  });
});

test.each([
  ['a matching peer', { 'client#1': ANDROID_PEER }, { ok: true, peers: 1, targets: 1 }],
  ['no matching peer', { 'client#1': IOS_PEER }, { failed: true, noPeer: true, peers: 1 }],
])('peersOnly reports %s and sends no reload', async (_label, connected, expected) => {
  const harness = peerServer(peers(connected));

  await withServer(harness, async (port) => {
    const result = await reloadThroughMetro(port, { role: 'android', appId: 'com.example.android', peersOnly: true });
    expect(result).toMatchObject(expected);
    expect(harness.messages).toEqual([expect.objectContaining({ method: 'getpeers' })]);
  });
});

// An iOS app whose first bundle fails never opens a packager connection at all:
// bridgeless RCTInstance resolves DevSettings only in _loadJSBundle's success
// callback, and RCTDevSettings.initialize is what both opens the /message socket
// and registers the reload handler. Fixed by react/react-native#58352, which has
// landed but is not in a release yet, so every released RN still behaves this
// way. The app is absent from getpeers rather than present-but-deaf, and that is
// the shape Stim must turn into a UI-automation remedy.
test('Metro reload reports no peer when the app never connected', async () => {
  const harness = peerServer(peers({}));

  await withServer(harness, async (port) => {
    const result = await reloadThroughMetro(port, { role: 'ios', appId: 'com.example.ios' });
    expect(result).toMatchObject({ failed: true, noPeer: true, peers: 0 });
    expect(result.reason).toContain(`No iOS React Native app is connected to Metro on port ${port}.`);
    expect(result.reason).toContain('Nothing at all is connected to it');
  });
});

// @react-native-community/cli-server-api answers getpeers out of
// `otherWs.upgradeReq.url`, a ws property removed in 3.0, so every published
// version of the bare dev server throws instead of returning peers. Its
// broadcast path does not touch that property, so it still reaches the app.
test.each([
  ['the TypeError bare Metro throws', "TypeError: Cannot read properties of undefined (reading 'url')"],
  ['any other enumeration error', 'unknown method: getpeers'],
])('a Metro that cannot enumerate peers is reloaded by broadcast: %s', async (_label, error) => {
  const harness = peerServer((id) => ({ version: 2, id, error }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'android', appId: 'com.example.android' })).resolves.toEqual({
      ok: true,
      broadcast: true,
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload' },
    ]);
  });
});

// A workspace Metro serves one app, so two iOS peers are that app on two
// devices. iOS peer metadata could not tell them apart anyway.
test('every matching peer is reloaded, because they are one app on several devices', async () => {
  const harness = peerServer(peers({ 'client#1': IOS_PEER, 'client#2': ANDROID_PEER, 'client#3': IOS_PEER_RAW }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'ios', appId: 'com.example.ios' })).resolves.toEqual({
      ok: true,
      peers: 3,
      targets: 2,
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload', target: 'client#1' },
      { version: 2, method: 'reload', target: 'client#3' },
    ]);
  });
});

// A bundle id and a package name are often the same string, so the two matchers
// must not fall back to each other's key.
test.each([
  ['an Android peer for an iOS target', 'ios', 'device=sdk_gphone64&app=io.tlon.groups&clientid=c1'],
  ['an iOS peer for an Android target', 'android', IOS_PEER_RAW],
])('%s is never addressed as a match, only swept up by the last-resort broadcast', async (_l, role, peer) => {
  const harness = peerServer(peers({ 'client#1': peer }));

  await withServer(harness, async (port) => {
    await expect(
      reloadThroughMetro(port, { role: role as 'ios' | 'android', appId: 'io.tlon.groups' }),
    ).resolves.toMatchObject({ noPeer: true, peers: 1 });
    await harness.reloadSeen;
    // Untargeted, so it is never claimed as this peer's reload.
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload' },
    ]);
  });
});

// @expo/cli stores `url.parse(req.url).query`, which is null when the connection
// URL carries no query, and getpeers substitutes {} when the property is absent.
test('a peer with no usable metadata is counted but never matched', async () => {
  const harness = peerServer(peers({ 'client#1': null, 'client#2': IOS_PEER_RAW }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'ios', appId: 'com.example.ios' })).resolves.toEqual({
      ok: true,
      peers: 2,
      targets: 1,
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ version: 2, method: 'getpeers', target: 'server' }),
      { version: 2, method: 'reload', target: 'client#2' },
    ]);
  });
});

// `unreachable` carries its own remedy -- retry the dev server, do not touch the
// device -- so the engine has to actually produce it, not just the command fakes.
test('a Metro that accepts the socket and never answers reports itself unreachable', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/message' });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');

  try {
    await expect(
      reloadThroughMetro(address.port, { role: 'ios', appId: 'com.example.ios', timeoutMs: 50 }),
    ).resolves.toEqual({
      failed: true,
      unreachable: true,
      reason: `Metro did not answer on port ${address.port}.`,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a refused connection reports itself unreachable rather than a missing peer', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const result = await reloadThroughMetro(address.port, { role: 'ios', appId: 'com.example.ios' });

  expect(result).toMatchObject({ failed: true, unreachable: true });
  expect(result.reason).toContain('Metro reload failed:');
  expect(result.noPeer).toBeUndefined();
});

test('without an app id, a reload for Android reaches every non-iOS peer and leaves iOS alone', async () => {
  const harness = peerServer(peers({ 'client#1': IOS_PEER, 'client#2': ANDROID_PEER, 'client#3': ANDROID_PEER_RAW }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, { role: 'android' })).resolves.toEqual({ ok: true, peers: 3, targets: 2 });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ method: 'getpeers' }),
      { version: 2, method: 'reload', target: 'client#2' },
      { version: 2, method: 'reload', target: 'client#3' },
    ]);
  });
});

test('without a platform, a reload reaches every peer and names the platforms they reported', async () => {
  const harness = peerServer(peers({ 'client#1': IOS_PEER, 'client#2': ANDROID_PEER }));

  await withServer(harness, async (port) => {
    await expect(reloadThroughMetro(port, {})).resolves.toEqual({
      ok: true,
      peers: 2,
      targets: 2,
      platforms: ['ios', 'android'],
    });
    await harness.reloadSeen;
    expect(harness.messages).toEqual([
      expect.objectContaining({ method: 'getpeers' }),
      { version: 2, method: 'reload', target: 'client#1' },
      { version: 2, method: 'reload', target: 'client#2' },
    ]);
  });
});

test('without a platform, Metro with no peers reports no app instead of an iOS or Android one', async () => {
  const harness = peerServer(peers({}));

  await withServer(harness, async (port) => {
    const result = await reloadThroughMetro(port, { peersOnly: true });
    expect(result).toMatchObject({ failed: true, noPeer: true, peers: 0 });
    expect(result.reason).toMatch(/^No React Native app is connected/);
  });
});

test('an exact reload that finds no matching peer broadcasts nothing to the other clients', async () => {
  const harness = peerServer(peers({ 'client#1': ANDROID_PEER }));

  await withServer(harness, async (port) => {
    const result = await reloadThroughMetro(port, { role: 'ios', exact: true });
    expect(result).toMatchObject({ failed: true, noPeer: true, peers: 1 });
    await delay(50);
    expect(harness.messages).toEqual([expect.objectContaining({ method: 'getpeers' })]);
  });
});
