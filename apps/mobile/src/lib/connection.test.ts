import { pair, StimConnection, type ConnectionState } from '@/lib/connection';
import type { ServerEvent } from '@/protocol/types';

class FakeSocket {
  sent: { id: number; method: string; params: unknown }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  reply(method: string, result: unknown) {
    const request = this.sent.findLast((m) => m.method === method);
    if (!request) throw new Error(`no ${method} request`);
    this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
  }
  fail(method: string, code: string) {
    const request = this.sent.find((m) => m.method === method);
    if (!request) throw new Error(`no ${method} request`);
    this.onmessage?.({ data: JSON.stringify({ id: request.id, error: { code, message: code } }) });
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const hello = { protocol: 1, server: { name: 'Mac', version: '1', stim: '1.9.0' }, capabilities: ['read'] };

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const states: ConnectionState[] = [];
  const connection = new StimConnection({
    endpoint: 'wss://mac',
    auth: { deviceToken: 'd' },
    client: { name: 'test', version: '0' },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
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

    sockets[0].onopen?.();
    sockets[0].reply('hello', hello);
    await flush();
    sockets[0].reply('status.subscribe', { subscription: 's1' });
    await flush();
    sockets[0].emit({ event: 'status', subscription: 's1', payload: { environments: [] } });

    sockets[0].close();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0].fn();
    sockets[1].onopen?.();
    sockets[1].reply('hello', hello);
    await flush();
    expect(sockets[1].sent.map((m) => m.method)).toEqual(['hello', 'status.subscribe']);
    sockets[1].reply('status.subscribe', { subscription: 's9' });
    await flush();
    sockets[1].emit({ event: 'status', subscription: 's1', payload: { environments: [1] } });
    sockets[1].emit({ event: 'status', subscription: 's9', payload: { environments: [2] } });

    expect(events.map((e) => (e.event === 'status' ? e.payload.environments : null))).toEqual([[], [2]]);
  });

  it('doubles the retry delay up to 30 seconds and resets it after a successful hello', async () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    for (let i = 0; i < 7; i++) {
      sockets[i].close();
      timers[i].fn();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    sockets[7].onopen?.();
    sockets[7].reply('hello', hello);
    await flush();
    sockets[7].close();
    expect(timers[7].ms).toBe(1000);
  });

  it('stops retrying when the server refuses the device token', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.start();
    sockets[0].onopen?.();
    sockets[0].fail('hello', 'unauthorized');
    await flush();
    expect(timers).toHaveLength(0);
    expect(states.at(-1)).toEqual({ kind: 'refused', code: 'unauthorized', reason: 'unauthorized' });
  });

  it('reports the actions hello grants, and none from a server that predates actions', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.start();
    sockets[0].onopen?.();
    sockets[0].reply('hello', { ...hello, capabilities: ['read', 'control'], actions: ['reload', 'stop'] });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: ['reload', 'stop'] });
    sockets[0].close();
    timers[0].fn();
    sockets[1].onopen?.();
    sockets[1].reply('hello', hello);
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: [] });
  });

  it('reconnects at once on request, so a grant made on the Mac shows without waiting for a drop', async () => {
    const { connection, sockets, timers, states } = setup();
    connection.subscribe('status.subscribe', {}, () => {});
    connection.start();
    sockets[0].onopen?.();
    sockets[0].reply('hello', hello);
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: [] });

    connection.reconnect();
    expect(sockets[0].closed).toBe(true);
    expect(timers).toHaveLength(0);
    sockets[1].onopen?.();
    sockets[1].reply('hello', { ...hello, capabilities: ['read', 'control'], actions: ['reload', 'stop'] });
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'open', actions: ['reload', 'stop'] });
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
      sockets[i].onopen?.();
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
    sockets[0].onopen?.();
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
    sockets[0].onopen?.();
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
  it('spends the pairing token and returns the issued device token', async () => {
    const socket = new FakeSocket();
    const result = pair(
      'wss://mac',
      'p',
      'iPhone',
      { name: 'test', version: '0' },
      () => socket as unknown as WebSocket,
    );
    socket.onopen?.();
    expect(socket.sent[0]).toMatchObject({
      method: 'hello',
      params: { auth: { pairingToken: 'p', deviceName: 'iPhone' } },
    });
    socket.reply('hello', { ...hello, deviceToken: 'dev' });
    await expect(result).resolves.toEqual({ deviceToken: 'dev', serverName: 'Mac' });
    expect(socket.closed).toBe(true);
  });

  it('reports an unreachable endpoint', async () => {
    const socket = new FakeSocket();
    const result = pair(
      'wss://mac',
      'p',
      'iPhone',
      { name: 'test', version: '0' },
      () => socket as unknown as WebSocket,
    );
    socket.close();
    await expect(result).rejects.toThrow('Cannot reach wss://mac.');
  });
});
