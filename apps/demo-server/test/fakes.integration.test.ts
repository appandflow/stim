import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import type { Method } from '@stim-cli/core/phone-protocol';
import { isRpcError, isRpcEvent, isRpcResult } from '@stim-cli/core/receive-protocol';

import { DemoMachine } from '../src/demo.ts';
import { loadFixtures } from './load-fixtures.ts';

interface Message {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
  event?: string;
  subscription?: string;
}

it('demo hello, RPCs and subscription events pass the phone receive validators', async () => {
  const received: Message[] = [];
  const fixtures = loadFixtures();
  const machine = new DemoMachine(fixtures, 'Demo Mac', {
    token: undefined,
    keyPair: generateNoiseKeyPair(),
    devices: new Map(),
  });
  const connection = machine.connect(
    { send: (text) => received.push(JSON.parse(text)), close: () => {} },
    { id: 'abcd1234', name: 'Phone' },
  );
  onTestFinished(() => connection.close());
  const workspace = fixtures.status.environments[0]?.path ?? '';
  let nextId = 1;
  const request = async (method: Method, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    await connection.receive(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(received.some((message) => message.id === id)).toBe(true));
    const message = received.find((candidate) => candidate.id === id) ?? { id };
    expect({ method, ok: message.error ? isRpcError(message.error) : isRpcResult(method, message.result) }).toEqual({
      method,
      ok: true,
    });
    return message;
  };
  const hello = await request('hello');
  expect(hello.result).toMatchObject({
    phoneApi: 2,
    host: { owner: 'service', capabilities: expect.any(Array), app: null },
  });
  const calls: [Method, Record<string, unknown>][] = [
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
  for (const [method, params] of calls) {
    expect({ method, result: (await request(method, params)).result }).toEqual({
      method,
      result: expect.anything(),
    });
  }
  expect((await request('stats.get')).error).toBeDefined();
  const subscribeMethods: Method[] = [
    'workspaces.subscribe',
    'workspace.subscribe',
    'machine.subscribe',
    'logs.subscribe',
    'frames.subscribe',
  ];
  for (const method of subscribeMethods) {
    const reply = await request(method, { workspace, platform: 'ios' });
    const subscription = reply.result?.subscription;
    await vi.waitFor(() => expect(received.some((message) => message.subscription === subscription)).toBe(true), {
      timeout: 3000,
    });
    for (const event of received.filter((message) => message.subscription === subscription)) {
      expect({ method, ok: isRpcEvent(event) }).toEqual({ method, ok: true });
    }
    await request('unsubscribe', { subscription });
  }
});
