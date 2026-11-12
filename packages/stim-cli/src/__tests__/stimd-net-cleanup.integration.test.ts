import type { EventEmitter } from 'node:events';

const state = vi.hoisted(() => {
  const value: { current: EventEmitter | null; messages: string[]; terminations: number } = {
    current: null,
    messages: [],
    terminations: 0,
  };
  return value;
});
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        state.current = this;
      }
      postMessage(message: { type: string }) {
        state.messages.push(message.type);
      }
      async terminate() {
        state.terminations++;
        this.emit('exit', 1);
        return 1;
      }
    },
  };
});
vi.mock('../spawn-entry.ts', () => ({ spawnEntry: () => 'fixture' }));

import { createNetThread, type NetOptions } from '../stimd/net.ts';

const options: NetOptions = {
  port: 0,
  extraEnv: [],
  pathPrepend: [],
  loopbackOnly: true,
  shareOnly: false,
  desktopKey: 'key',
  script: 'fixture',
};
const log = () => {};
const current = () => {
  if (!state.current) throw new Error('worker not started');
  return state.current;
};
beforeEach(() => {
  state.current = null;
  state.messages = [];
  state.terminations = 0;
});
afterEach(() => vi.useRealTimers());

async function listening() {
  const onExit = vi.fn<(error?: Error) => void>();
  const net = createNetThread(log, onExit);
  const started = net.ensure(options);
  current().emit('message', { type: 'listening', port: 1234 });
  await started;
  return { net, onExit };
}

test('close requires a successful cleanup acknowledgement and worker exit', async () => {
  const { net, onExit } = await listening();
  const closing = net.close();
  current().emit('message', { type: 'closed' });
  current().emit('exit', 0);
  await expect(closing).resolves.toBeUndefined();
  expect(onExit).toHaveBeenCalledWith();
});

test.each(['child still running', ''])('failed cleanup stays sticky after the worker exits: %s', async (message) => {
  const { net, onExit } = await listening();
  const closing = net.close();
  current().emit('message', { type: 'closed', error: message });
  expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ reportCleanup: true }));
  current().emit('exit', 0);
  await expect(closing).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  await expect(net.close()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ reportCleanup: true }));
});

test('unexpected worker exit preserves unverified cleanup', async () => {
  const { net, onExit } = await listening();
  current().emit('exit', 1);
  expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ reportCleanup: true }));
  await expect(net.close()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});

test('failure callback can close immediately after an unexpected exit', async () => {
  let closing: Promise<void> | undefined;
  const net = createNetThread(log, () => {
    closing = net.close();
  });
  const started = net.ensure(options);
  current().emit('message', { type: 'listening', port: 1234 });
  await started;
  current().emit('exit', 1);
  if (!closing) throw new Error('failure callback did not close the net thread');
  await expect(closing).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});

test('a clean exit without an acknowledgement remains unverified', async () => {
  const { net } = await listening();
  const closing = net.close();
  current().emit('exit', 0);
  await expect(closing).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});

test('forced termination after acknowledgement still preserves unverified cleanup', async () => {
  vi.useFakeTimers();
  const { net } = await listening();
  const closing = net.close();
  current().emit('message', { type: 'closed' });
  void closing.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(closing).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  expect(state.terminations).toBe(1);
});

test('a clean startup refusal can be retried', async () => {
  const net = createNetThread(log, () => {});
  const first = net.ensure(options);
  current().emit('message', { type: 'refused', message: 'port in use', clean: true });
  await expect(first).resolves.toMatchObject({ listening: false });
  const second = net.ensure(options);
  current().emit('message', { type: 'listening', port: 1234 });
  await expect(second).resolves.toMatchObject({ listening: true });
  const closing = net.close();
  current().emit('message', { type: 'closed' });
  current().emit('exit', 0);
  await closing;
});

test('a restart message from the net thread reaches stimd', async () => {
  const onRestart = vi.fn<(why: string) => void>();
  const net = createNetThread(
    log,
    () => {},
    () => {},
    onRestart,
  );
  const started = net.ensure(options);
  current().emit('message', { type: 'listening', port: 1234 });
  await started;
  current().emit('message', { type: 'restart', why: 'unit rewritten' });
  expect(onRestart).toHaveBeenCalledWith('unit rewritten');
});
