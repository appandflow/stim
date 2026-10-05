import type { Method } from '@stim-cli/core/phone-protocol';
import { isRpcError, isRpcEvent, isRpcResult } from '@stim-cli/core/receive-protocol';

import { DemoMachine, type Device } from '../src/demo.ts';
import { loadFixtures } from './load-fixtures.ts';

const TOKEN = 'review-token-for-tests';
const fixtures = loadFixtures();
const SEARCH = '/Users/demo/Developer/habitat-app/.worktrees/search-screen';
const SORTING = '/Users/demo/Developer/notes-app/.worktrees/note-sorting';

interface Message {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  event?: string;
  subscription?: string;
  data?: string;
}

function phone(machine: DemoMachine, device: Device | null = null) {
  const received: Message[] = [];
  const remembered: Device[] = [];
  let closed = false;
  const connection = machine.connect(
    {
      send: (text) => received.push(JSON.parse(text) as Message),
      close: () => {
        closed = true;
      },
      remember: (value) => remembered.push(value),
    },
    device,
  );
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    await connection.receive(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true));
    const reply = received.find((message) => message.id === id)!;
    const accepted = reply.error ? isRpcError(reply.error) : isRpcResult(method as Method, reply.result);
    expect(accepted, `${method} reply the phone accepts`).toBe(true);
    return reply;
  };
  const events = (name: string): Message[] => received.filter((message) => message.event === name);
  return { connection, request, events, remembered, closed: () => closed };
}

const pair = (machine: DemoMachine, pairingToken = TOKEN) => {
  const client = phone(machine);
  return {
    ...client,
    hello: client.request('hello', { protocol: 1, auth: { pairingToken, deviceName: 'Review iPhone' } }),
  };
};

describe('pairing', () => {
  it('pairs with the fixed token any number of times and reconnects with the issued device token', async () => {
    const machine = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    const first = pair(machine);
    const second = pair(machine);
    const deviceToken = (await first.hello).result?.deviceToken;
    expect(typeof deviceToken).toBe('string');
    expect((await second.hello).result?.deviceToken).toEqual(expect.any(String));
    expect(first.remembered).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}$/), name: 'Review iPhone' }]);

    const restarted = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    const again = phone(restarted);
    const reply = await again.request('hello', { protocol: 1, auth: { deviceToken } });
    expect(reply.result?.server).toMatchObject({ name: 'Demo Mac' });
    expect(reply.result?.capabilities).toEqual(['read', 'control']);
  });

  it('refuses a wrong pairing token, a forged device token, and every token when none is configured', async () => {
    const machine = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    const wrong = phone(machine);
    expect((await wrong.request('hello', { protocol: 1, auth: { pairingToken: 'guess' } })).error?.code).toBe(
      'pairing-expired',
    );
    expect(wrong.closed()).toBe(true);

    const other = new DemoMachine(fixtures, 'Demo Mac', 'another-token');
    const foreign = (await pair(other, 'another-token').hello).result?.deviceToken;
    expect(typeof foreign).toBe('string');
    for (const deviceToken of [foreign, 'made-up', `${String(foreign)}.extra`]) {
      const client = phone(machine);
      expect((await client.request('hello', { protocol: 1, auth: { deviceToken } })).error?.code).toBe('unauthorized');
    }

    for (const token of [undefined, '']) {
      const unset = new DemoMachine(fixtures, 'Demo Mac', token);
      expect((await pair(unset, '').hello).error?.code).toBe('pairing-expired');
    }
  });

  it('answers nothing but hello before pairing', async () => {
    const client = phone(new DemoMachine(fixtures, 'Demo Mac', TOKEN));
    expect((await client.request('status.subscribe')).error?.code).toBe('unauthorized');
  });

  it('accepts the device token kept in the socket attachment after hibernation', async () => {
    const machine = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    const client = phone(machine, { id: 'abcd1234', name: 'Review iPhone' });
    expect((await client.request('machine.get')).result).toBeDefined();
  });
});

describe('the phone protocol', () => {
  it('serves every read method in shapes the phone accepts', async () => {
    const client = pair(new DemoMachine(fixtures, 'Demo Mac', TOKEN));
    await client.hello;
    const calls: [string, Record<string, unknown>][] = [
      ['logs.query', { workspace: SEARCH, tail: 20 }],
      ['workspace.files', { workspace: SEARCH, group: 'tracked' }],
      ['workspace.diff', { workspace: SEARCH, path: 'src/screens/search.tsx' }],
      ['build.plan', { workspace: SEARCH, platform: 'ios' }],
      ['build.plan', { workspace: SEARCH, platform: 'android' }],
      ['settings.get', {}],
      ['replay.range', { workspace: SEARCH, platform: 'ios' }],
      ['machine.get', {}],
      ['machine.history', {}],
      ['machine.details', {}],
      ['notifications.list', {}],
    ];
    for (const [method, params] of calls) expect((await client.request(method, params)).result).toBeDefined();
  });

  it('streams status, logs and frames as events the phone accepts', async () => {
    const client = pair(new DemoMachine(fixtures, 'Demo Mac', TOKEN));
    await client.hello;
    await client.request('status.subscribe');
    await client.request('logs.subscribe', { workspace: SEARCH });
    for (const [workspace, platform] of [
      [SEARCH, 'ios'],
      [SEARCH, 'android'],
      [SORTING, 'web'],
      [SORTING, 'macos'],
    ]) {
      await client.request('frames.subscribe', { workspace, platform, slot: 'default' });
    }
    await vi.waitFor(() => {
      expect(client.events('status')).toHaveLength(1);
      expect(client.events('logs')).toHaveLength(1);
      expect(client.events('frame')).toHaveLength(4);
    });
    for (const event of [...client.events('status'), ...client.events('logs'), ...client.events('frame')]) {
      expect(isRpcEvent(event), `${String(event.event)} event the phone accepts`).toBe(true);
    }
    client.connection.close();
  });

  it('answers reload and stop after a short delay', async () => {
    const client = pair(new DemoMachine(fixtures, 'Demo Mac', TOKEN));
    await client.hello;
    const reply = await client.request('action', { action: 'reload', workspace: SEARCH, platform: 'ios' });
    expect(reply.result).toMatchObject({ action: 'reload', workspace: SEARCH });
  });

  it('sends nothing to a phone that disconnected before a reload finished', async () => {
    const machine = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    let open = true;
    const connection = machine.connect(
      {
        send: () => {
          if (!open) throw new Error('send after close');
        },
        close: () => {},
        remember: () => {},
      },
      { id: 'abcd1234', name: 'Phone' },
    );
    await connection.receive(
      JSON.stringify({ id: 1, method: 'action', params: { action: 'stop', workspace: SEARCH } }),
    );
    open = false;
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(machine.busy.size).toBe(0);
  });
});

describe('Control', () => {
  it('switches the device to its other screen on each tap, but not on a drag, for every phone watching it', async () => {
    const machine = new DemoMachine(fixtures, 'Demo Mac', TOKEN);
    const driver = pair(machine);
    const watcher = pair(machine);
    await Promise.all([driver.hello, watcher.hello]);
    const target = { workspace: SEARCH, platform: 'ios', slot: 'default' };
    await watcher.request('frames.subscribe', target);
    await vi.waitFor(() => expect(watcher.events('frame')).toHaveLength(1));
    const [list, detail] = fixtures.frames.ios!.map((frame) => frame.data);
    expect(watcher.events('frame')[0]?.data).toBe(list);

    const begin = await driver.request('control.begin', target);
    expect(begin.result).toMatchObject({ platform: 'ios', lease: null, postures: [] });
    const session = begin.result?.session;
    const touch = (phase: string, x: number, y: number) => driver.request('input.touch', { session, phase, x, y });
    await touch('down', 0.5, 0.3);
    expect(watcher.events('frame').at(-1)?.data).toBe(list);
    await touch('up', 0.5, 0.3);
    expect(watcher.events('frame').at(-1)?.data).toBe(detail);
    await touch('down', 0.5, 0.8);
    await touch('move', 0.5, 0.5);
    await touch('up', 0.5, 0.2);
    expect(watcher.events('frame').at(-1)?.data).toBe(detail);
    await touch('down', 0.1, 0.1);
    await touch('up', 0.11, 0.1);
    expect(watcher.events('frame').at(-1)?.data).toBe(list);

    for (const [method, params] of [
      ['input.text', { text: 'water' }],
      ['input.button', { button: 'home' }],
      ['input.rotate', { direction: 'left' }],
      ['input.simulator', { action: 'read' }],
    ] as const) {
      expect((await driver.request(method, { session, ...params })).result).toBeDefined();
    }
    await driver.request('control.end', { session });
    expect((await driver.request('input.touch', { session, phase: 'up', x: 0, y: 0 })).error?.code).toBe(
      'unknown-session',
    );
    watcher.connection.close();
  });

  it('refuses a workspace that is not in the status payload', async () => {
    const client = pair(new DemoMachine(fixtures, 'Demo Mac', TOKEN));
    await client.hello;
    const reply = await client.request('control.begin', { workspace: '/elsewhere', platform: 'ios' });
    expect(reply.error?.code).toBe('bad-request');
  });
});
