import * as Sentry from '@sentry/react-native';

import capturedStatus from '../../mock-server/fixtures/status.json';
import {
  receiveStatus,
  replaceReceivedField,
  statusEnumPaths,
  resultEnumCases,
  eventEnumCases,
  archivedLogsEnded,
} from '../../mock-server/receive-fixtures';
import type { StatusPayload, Methods } from '@/protocol/types';
import { pair, pairingScope, StimConnection, type ConnectionState } from '@/lib/connection';
import type { SessionClose, SocketAuth, VideoStream } from '@/lib/socket';
import type { ServerEvent } from '@/protocol/types';

jest.mock('@sentry/react-native', () => ({ captureMessage: jest.fn(), addBreadcrumb: jest.fn() }));

class FakeSocket {
  sent: { id: number; method: string; params: unknown }[] = [];
  closed = false;
  streams: { subscription: string; disposed: boolean; dispose: () => void }[] = [];
  onopen: ((serverKey: string) => void) | null = null;
  onmessage: ((text: string) => void) | null = null;
  onclose: ((event: SessionClose) => void) | null = null;

  constructor(readonly auth: SocketAuth = { serverKey: 'k' }) {}

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.drop({ code: 1006, reason: '', serverAnswered: true, handshakeComplete: true });
  }
  drop(event: SessionClose) {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(event);
  }
  videoStream(subscription: string): VideoStream {
    const record = { subscription, disposed: false, dispose: () => {} };
    record.dispose = () => {
      record.disposed = true;
    };
    this.streams.push(record);
    return {
      name: 'VideoStream',
      toString: () => 'VideoStream',
      equals: () => false,
      dispose: () => record.dispose(),
      push: () => {},
      onFormat: undefined,
      onProgress: undefined,
      timing: () => ({
        enabled: false,
        received: 0,
        decoded: 0,
        presented: 0,
        dropped: 0,
        meanDecodeQueueMs: 0,
        maxDecodeQueueMs: 0,
        meanPresentMs: 0,
        maxPresentMs: 0,
      }),
    };
  }
  timing() {
    return {
      enabled: false,
      messages: 0,
      videoMessages: 0,
      droppedVideoMessages: 0,
      meanDecryptMs: 0,
      maxDecryptMs: 0,
      meanRouteMs: 0,
      maxRouteMs: 0,
    };
  }
  reply(method: string, result: unknown) {
    const request = this.sent.findLast((m) => m.method === method);
    if (!request) throw new Error(`no ${method} request`);
    this.onmessage?.(JSON.stringify({ id: request.id, result }));
  }
  fail(method: string, code: string) {
    const request = this.sent.find((m) => m.method === method);
    if (!request) throw new Error(`no ${method} request`);
    this.onmessage?.(JSON.stringify({ id: request.id, error: { code, message: code } }));
  }
  emit(event: unknown) {
    this.onmessage?.(JSON.stringify(event));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const status = {
  environments: [],
  capacity: { liveCount: 0, committedMb: 0, totalMemoryMb: 1024, overCapacity: false },
  deviceLeases: [],
  simctlAvailable: true,
};
const currentWorkspace = { path: '/current', live: false, memoryMb: 0, warnings: [], issues: [] };
const hello = { protocol: 2, server: { name: 'Mac', version: '1', stim: '1.9.0' }, capabilities: ['read'] };

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const states: ConnectionState[] = [];
  const connection = new StimConnection({
    endpoint: 'wss://mac',
    serverKey: 'pinned',
    client: { name: 'test', version: '0' },
    createSocket: (_url, auth) => {
      const socket = new FakeSocket(auth);
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    onState: (state) => states.push(state),
  });
  return { connection, sockets, timers, states };
}

describe('StimConnection', () => {
  it('resubscribes after a reconnect and routes events by the new subscription id', async () => {
    const { connection, sockets, timers } = setup();
    const events: ServerEvent[] = [];
    connection.subscribe('status.subscribe', {}, (event) => events.push(event));
    connection.start();

    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('status.subscribe', { subscription: 's1' });
    await flush();
    sockets[0].emit({ event: 'status', subscription: 's1', payload: status });

    sockets[0].close();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0].fn();
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', hello);
    await flush();
    expect(sockets[1].sent.map((m) => m.method)).toEqual(['hello', 'status.subscribe']);
    sockets[1].reply('status.subscribe', { subscription: 's9' });
    await flush();
    sockets[1].emit({ event: 'status', subscription: 's1', payload: { environments: [1] } });
    sockets[1].emit({ event: 'status', subscription: 's9', payload: { ...status, environments: [currentWorkspace] } });

    expect(events.map((e) => (e.event === 'status' ? e.payload.environments : null))).toEqual([[], [currentWorkspace]]);
  });

  it('gives each H.264 subscription its own stream and disposes it when the subscription ends', async () => {
    const { connection, sockets, timers } = setup();
    const results: unknown[] = [];
    const streams: VideoStream[] = [];
    const unsubscribe = connection.subscribe(
      'frames.subscribe',
      { workspace: '/w', platform: 'ios', video: ['h264'] },
      () => {},
      (result) => results.push(result),
      (stream) => streams.push(stream),
    );
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('frames.subscribe', { subscription: 's1', video: 'h264' });
    await flush();
    expect(sockets[0].streams.map((stream) => stream.subscription)).toEqual(['s1']);
    sockets[0].close();
    expect(sockets[0].streams[0]!.disposed).toBe(true);
    timers[0].fn();
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', hello);
    await flush();
    sockets[1].reply('frames.subscribe', { subscription: 's4', video: 'future-kind' });
    await flush();
    expect(sockets[1].streams).toEqual([]);
    connection.reconnect();
    sockets[2].onopen?.('k');
    sockets[2].reply('hello', hello);
    await flush();
    sockets[2].reply('frames.subscribe', { subscription: 's5', video: 'h264' });
    await flush();
    unsubscribe();
    expect(results).toEqual([
      { subscription: 's1', video: 'h264' },
      { subscription: 's4', video: 'future-kind' },
      { subscription: 's5', video: 'h264' },
    ]);
    expect(streams).toHaveLength(2);
    expect(sockets[2].streams[0]!.disposed).toBe(true);
  });

  it('pins the stored server key and stops retrying when the server refuses the session', async () => {
    const refusals: [SessionClose, string][] = [
      [
        { code: 4400, reason: 'unexpected binary frame', serverAnswered: false, handshakeComplete: false },
        'server-outdated',
      ],
      [{ code: 4401, reason: 'unauthorized', serverAnswered: true, handshakeComplete: true }, 'unauthorized'],
      [
        { code: 1006, reason: '', serverAnswered: true, handshakeComplete: false, error: 'server-key-mismatch' },
        'server-key-mismatch',
      ],
    ];
    for (const [event, code] of refusals) {
      const { connection, sockets, timers, states } = setup();
      connection.start();
      expect(sockets[0].auth).toEqual({ serverKey: 'pinned' });
      sockets[0].drop(event);
      expect(timers).toHaveLength(0);
      expect(states.at(-1)).toMatchObject({ kind: 'refused', code });
    }
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0].drop({ code: 1006, reason: '', serverAnswered: false, handshakeComplete: false });
    expect(timers).toHaveLength(1);
  });

  it('doubles the retry delay up to 30 seconds and resets it after a successful hello', async () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    for (let i = 0; i < 7; i++) {
      sockets[i].close();
      timers[i].fn();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    sockets[7].onopen?.('k');
    sockets[7].reply('hello', hello);
    await flush();
    sockets[7].close();
    expect(timers[7].ms).toBe(1000);
  });

  it('stops retrying when the server refuses the device token', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].fail('hello', 'unauthorized');
    await flush();
    expect(timers).toHaveLength(0);
    expect(states.at(-1)).toEqual({ kind: 'refused', code: 'unauthorized', reason: 'unauthorized' });
  });

  it('reports the actions and features hello grants, and their defaults from a server that predates them', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', { ...hello, capabilities: ['read', 'control'], actions: ['reload', 'stop'] });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: ['reload', 'stop'], features: [] });
    sockets[0].close();
    timers[0].fn();
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', { ...hello, features: ['physical-android'] });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: null, features: ['physical-android'] });
  });

  it('reconnects at once on request, so a grant made on the Mac shows without waiting for a drop', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.subscribe('status.subscribe', {}, () => {});
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', { ...hello, actions: [], device: { id: '1a2b3c4d', name: 'Phone' } });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: [], deviceId: '1a2b3c4d' });
    expect(pairingScope(states.at(-1)!)).toBe('read');

    connection.reconnect();
    expect(pairingScope(states.at(-1)!)).toBeNull();
    expect(sockets[0].closed).toBe(true);
    expect(timers).toHaveLength(0);
    sockets[0].onopen?.('k');
    expect(sockets[0].sent.map((m) => m.method)).toEqual(['hello', 'status.subscribe']);
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', { ...hello, capabilities: ['read', 'control'], actions: ['reload', 'stop'] });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: ['reload', 'stop'], deviceId: null });
    expect(pairingScope(states.at(-1)!)).toBe('control');
    expect(sockets[1].sent.map((m) => m.method)).toEqual(['hello', 'status.subscribe']);
  });

  it('reports each resubscribe so a log list can drop the history it already shows', async () => {
    const { connection, sockets, timers } = setup();
    let subscribed = 0;
    connection.subscribe(
      'logs.subscribe',
      { workspace: '/w' },
      () => {},
      () => subscribed++,
    );
    connection.start();
    for (const [i, id] of ['s1', 's2'].entries()) {
      sockets[i].onopen?.('k');
      sockets[i].reply('hello', hello);
      await flush();
      sockets[i].reply('logs.subscribe', { subscription: id });
      await flush();
      sockets[i].close();
      timers[i].fn();
    }
    expect(subscribed).toBe(2);
  });

  it('subscribes again, after a doubling delay, when the server ends a subscription with an error', async () => {
    const { connection, sockets, timers } = setup();
    const events: ServerEvent[] = [];
    connection.subscribe('logs.subscribe', { workspace: '/w' }, (event) => events.push(event));
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('logs.subscribe', { subscription: 's1' });
    await flush();

    const error = { code: 'logs-failed', message: 'stim logs --follow exited (code 1)' };
    sockets[0].emit({ event: 'error', subscription: 's1', error });
    expect(events).toEqual([{ event: 'error', subscription: 's1', error }]);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0].fn();
    expect(sockets[0].sent.map((m) => m.method)).toEqual(['hello', 'logs.subscribe', 'logs.subscribe']);

    sockets[0].reply('logs.subscribe', { subscription: 's2' });
    await flush();
    sockets[0].emit({ event: 'error', subscription: 's2', error });
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000]);
    timers[1].fn();
    sockets[0].reply('logs.subscribe', { subscription: 's3' });
    await flush();
    sockets[0].emit({ event: 'logs', subscription: 's3', records: [] });
    sockets[0].emit({ event: 'error', subscription: 's3', error });
    expect(timers.at(-1)?.ms).toBe(1000);
  });

  it('unsubscribes on the server when a screen stops listening', async () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    const stop = connection.subscribe('logs.subscribe', { workspace: '/w' }, () => {});
    sockets[0].reply('logs.subscribe', { subscription: 's4' });
    await flush();
    stop();
    expect(sockets[0].sent.at(-1)).toMatchObject({ method: 'unsubscribe', params: { subscription: 's4' } });
  });
});

describe('pair', () => {
  it('spends the pairing token, checks the QR key, and returns the key to pin', async () => {
    let socket!: FakeSocket;
    const result = pair(
      'wss://mac',
      { pairingToken: 'p', serverKey: 'qr' },
      'iPhone',
      { name: 'test', version: '0' },
      (_url, auth) => {
        socket = new FakeSocket(auth);
        return socket;
      },
    );
    expect(socket.auth).toEqual({ pairingToken: 'p', serverKey: 'qr' });
    socket.onopen?.('qr');
    expect(socket.sent[0]).toMatchObject({ method: 'hello', params: { protocol: 2, deviceName: 'iPhone' } });
    expect(socket.sent[0]!.params).not.toHaveProperty('auth');
    socket.reply('hello', hello);
    await expect(result).resolves.toEqual({ serverKey: 'qr', serverName: 'Mac' });
    expect(socket.closed).toBe(true);
  });

  it('reports an unreachable endpoint, and tells an old stim-server apart', async () => {
    const socket = new FakeSocket();
    const result = pair('wss://mac', { pairingToken: 'p' }, 'iPhone', { name: 'test', version: '0' }, () => socket);
    socket.close();
    await expect(result).rejects.toThrow('Cannot reach wss://mac.');
    const old = new FakeSocket();
    const refused = pair('wss://mac', { pairingToken: 'p' }, 'iPhone', { name: 'test', version: '0' }, () => old);
    old.drop({ code: 4400, reason: 'unexpected binary frame', serverAnswered: false, handshakeComplete: false });
    await expect(refused).rejects.toThrow('Update stim-server on this Mac.');
    const spent = new FakeSocket();
    const expired = pair('wss://mac', { pairingToken: 'p' }, 'iPhone', { name: 'test', version: '0' }, () => spent);
    spent.drop({ code: 4401, reason: 'unknown-secret', serverAnswered: true, handshakeComplete: false });
    await expect(expired).rejects.toThrow('expired or was already used');
  });
});

describe('RPC receive validation', () => {
  it('opens with a future approval label without granting capabilities the server omitted', async () => {
    const { connection, sockets, states, timers } = setup();
    connection.start();
    sockets[0]!.onopen?.('k');
    sockets[0]!.reply('hello', {
      ...hello,
      capabilities: [],
      approval: { state: 'future-kind', expiresAt: '2026-10-01T00:00:00Z' },
    });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', capabilities: [] });
    expect(sockets[0]!.closed).toBe(false);
    expect(timers).toEqual([]);
    connection.close();
  });
  it('rejects a response for another method and reconnects without resolving it', async () => {
    const { connection, sockets, states, timers } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    const result = connection.request('machine.get', {});
    const rejected = expect(result).rejects.toThrow('invalid RPC response');
    sockets[0].reply('machine.get', { subscription: 'wrong-method' });
    await rejected;
    expect(sockets[0].closed).toBe(true);
    expect(states.at(-1)).toMatchObject({ kind: 'waiting', retryInMs: 1000 });
    timers[0].fn();
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', { ...hello, features: ['future-feature'], extra: true });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', features: ['future-feature'] });
    connection.close();
  });

  it('keeps malformed nested log records out of listeners and resubscribes after reconnect', async () => {
    const { connection, sockets, timers } = setup();
    const listener = jest.fn();
    connection.subscribe('logs.subscribe', { workspace: '/current' }, listener);
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('logs.subscribe', { subscription: 's' });
    await flush();
    sockets[0].emit({ event: 'logs', subscription: 's', records: [{ ts: 1, src: 'metro', level: 'info', msg: 5 }] });
    expect(listener).not.toHaveBeenCalled();
    expect(sockets[0].closed).toBe(true);
    timers[0].fn();
    sockets[1].onopen?.('k');
    sockets[1].reply('hello', hello);
    await flush();
    expect(sockets[1].sent.map(({ method }) => method)).toEqual(['hello', 'logs.subscribe']);
    connection.close();
  });

  it('backs off when a server keeps sending an invalid event after a valid hello', async () => {
    const { connection, sockets, states, timers } = setup();
    connection.subscribe('logs.subscribe', { workspace: '/current' }, jest.fn());
    connection.start();
    const bad = { event: 'logs', subscription: 's', records: [{ ts: 1, src: 'metro', level: 'info', msg: 5 }] };
    for (const retryInMs of [1000, 2000]) {
      const socket = sockets.at(-1)!;
      socket.onopen?.('k');
      socket.reply('hello', hello);
      await flush();
      socket.reply('logs.subscribe', { subscription: 's' });
      await flush();
      socket.emit(bad);
      expect(states.at(-1)).toMatchObject({ kind: 'waiting', retryInMs });
      timers.at(-1)!.fn();
    }
    connection.close();
  });

  it('ignores unknown future events but closes malformed JSON without exposing its contents', async () => {
    const { connection, sockets, states } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].emit({ event: 'future-event', payload: null });
    expect(sockets[0].closed).toBe(false);
    sockets[0].onmessage?.('private malformed payload');
    expect(sockets[0].closed).toBe(true);
    expect(JSON.stringify(states)).not.toContain('private malformed payload');
    connection.close();
  });

  it('rejects a malformed pairing hello before storing the Mac', async () => {
    const socket = new FakeSocket();
    const promise = pair(
      'wss://mac',
      { pairingToken: 'pairing' },
      'Phone',
      { name: 'test', version: '0' },
      () => socket,
    );
    const rejected = expect(promise).rejects.toThrow('invalid pairing response');
    socket.onopen?.('k');
    socket.reply('hello', { ...hello, server: { name: 5 } });
    await rejected;
    expect(socket.closed).toBe(true);
  });
});

test.each([
  ...statusEnumPaths.map((path) => [path, 'future-kind'] as const),
  ['environments.0.build.missProvisional', false] as const,
])('keeps the socket open when status has a future value at %s', async (path, value) => {
  const { connection, sockets, timers } = setup();
  const seen: ServerEvent[] = [];
  connection.subscribe('status.subscribe', {}, (event) => seen.push(event));
  connection.start();
  sockets[0]!.onopen?.('k');
  sockets[0]!.reply('hello', hello);
  await flush();
  sockets[0]!.reply('status.subscribe', { subscription: 's' });
  await flush();
  sockets[0]!.emit({
    event: 'status',
    subscription: 's',
    payload: replaceReceivedField(receiveStatus(capturedStatus.payload as StatusPayload), path, value),
  });
  expect(seen).toHaveLength(1);
  expect(sockets[0]!.closed).toBe(false);
  expect(timers).toEqual([]);
  connection.close();
});

test.each(resultEnumCases)(
  'delivers %s with a future result value instead of reconnecting',
  async (method, fixture, path, value) => {
    const { connection, sockets, timers } = setup();
    connection.start();
    sockets[0]!.onopen?.('k');
    sockets[0]!.reply('hello', hello);
    await flush();
    const answer = connection.request(method, {} as Methods[typeof method]['params']);
    const received = replaceReceivedField(fixture, path, value);
    sockets[0]!.reply(method, received);
    await expect(answer).resolves.toEqual(received);
    expect(sockets[0]!.closed).toBe(false);
    expect(timers).toEqual([]);
    connection.close();
  },
);

test('delivers archived log completion to its subscriber without reconnecting', async () => {
  const { connection, sockets, timers } = setup();
  const seen: ServerEvent[] = [];
  connection.subscribe('logs.subscribe', { archive: 'app--123' }, (event) => seen.push(event));
  connection.start();
  sockets[0]!.onopen?.('k');
  sockets[0]!.reply('hello', hello);
  await flush();
  sockets[0]!.reply('logs.subscribe', { subscription: archivedLogsEnded.subscription });
  await flush();
  sockets[0]!.emit(archivedLogsEnded);
  expect(seen).toEqual([archivedLogsEnded]);
  expect(sockets[0]!.closed).toBe(false);
  expect(timers).toEqual([]);
  connection.close();
});

test.each(eventEnumCases)('keeps the socket open for future event values at %s', async (fixture, path) => {
  const { connection, sockets, timers } = setup();
  connection.start();
  sockets[0]!.onopen?.('k');
  sockets[0]!.reply('hello', hello);
  await flush();
  sockets[0]!.emit(replaceReceivedField(fixture, path, 'future-kind'));
  expect(sockets[0]!.closed).toBe(false);
  expect(timers).toEqual([]);
  connection.close();
});

describe('failure reports', () => {
  const captured = () =>
    (Sentry.captureMessage as jest.Mock).mock.calls as [string, { tags: Record<string, string> }][];

  it('names the failing schema keyword and path of an invalid result, but none of its values', async () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    const result = connection.request('machine.get', {});
    const rejected = expect(result).rejects.toThrow('invalid RPC response');
    sockets[0].reply('machine.get', { leaked: 'janics-mac.tail1a2b3.ts.net' });
    await rejected;

    const [message, options] = captured().find(([, o]) => o.tags.name === 'machine.get')!;
    expect(message).toBe('rpc-validation-failed');
    expect(options.tags).toMatchObject({ stage: 'result', name: 'machine.get' });
    expect(options.tags.keyword).toMatch(/^\w+$/);
    expect(options.tags.schema_path).toMatch(/^#/);
    expect(JSON.stringify(captured())).not.toContain('janics-mac');
    connection.close();
  });

  it('reports an invalid event by event name and schema location without its payload', async () => {
    const { connection, sockets } = setup();
    connection.subscribe('status.subscribe', {}, () => {});
    connection.start();
    sockets[0].onopen?.('k');
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('status.subscribe', { subscription: 's1' });
    await flush();
    sockets[0].emit({ event: 'notification', payload: { leaked: '/Users/janic/secret-app' } });

    const call = captured().find(([, o]) => o.tags.stage === 'event' && o.tags.name === 'notification');
    expect(call?.[1].tags.keyword).toBeTruthy();
    expect(JSON.stringify(captured())).not.toContain('secret-app');
    connection.close();
  });

  it('reports a pairing failure by its class only', async () => {
    const socket = new FakeSocket();
    const promise = pair(
      'wss://janics-mac.tail1a2b3.ts.net:7433',
      { pairingToken: 'pairing-secret-token' },
      'Janic phone',
      { name: 't', version: '0' },
      () => socket,
    );
    const rejected = expect(promise).rejects.toThrow();
    socket.close();
    await rejected;

    const call = captured().find(([m]) => m === 'pairing-failed');
    expect(call?.[1].tags).toEqual({ error_class: 'closed' });
    expect(JSON.stringify(captured())).not.toContain('tail1a2b3');
    expect(JSON.stringify(captured())).not.toContain('pairing-secret');
  });
});
