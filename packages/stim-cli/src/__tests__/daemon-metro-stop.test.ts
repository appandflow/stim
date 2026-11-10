const state = vi.hoisted(() => {
  const result: { reply: Record<string, unknown> | null; close: boolean; live: unknown[]; unresolved: unknown[] } = {
    reply: null,
    close: true,
    live: [],
    unresolved: [],
  };
  return result;
});

vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    connect: () => {
      class Socket extends EventEmitter {
        setEncoding() {}
        write() {
          if (state.reply) this.emit('data', `${JSON.stringify({ op: 'hello' })}\n${JSON.stringify(state.reply)}\n`);
          else if (state.close) this.emit('close');
        }
        destroy() {}
      }
      const socket = new Socket();
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
});
vi.mock('@stim-cli/core/ownership-claim', async (original) => ({
  ...(await original<typeof import('@stim-cli/core/ownership-claim')>()),
  readClaimSet: () => ({ live: state.live, unresolved: state.unresolved }),
}));

import { stopMetroTree } from '../daemon/client.ts';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
if (!platform) throw new Error('process.platform is unavailable');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  state.reply = null;
  state.close = true;
  state.live = [];
  state.unresolved = [];
});
afterEach(() => Object.defineProperty(process, 'platform', platform));

test('uses the acknowledged managed stop without invoking the fallback', async () => {
  state.reply = { op: 'metro.stopped', state: 'stopped' };
  const fallback = vi.fn<() => boolean>(() => true);
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toBe(true);
  expect(fallback).not.toHaveBeenCalled();
});

test('falls back on explicit not-owned or absent daemon and claims', async () => {
  const fallback = vi.fn<() => boolean>(() => true);
  state.reply = { op: 'metro.stopped', state: 'not-owned' };
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toBe(true);
  state.reply = null;
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toBe(true);
  expect(fallback).toHaveBeenCalledTimes(2);
});

test.each(['live', 'unresolved'])('refuses an unanswered stop with %s claims', async (kind) => {
  if (kind === 'live') state.live = [{}];
  else state.unresolved = [{}];
  const fallback = vi.fn<() => boolean>(() => true);
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toBe(false);
  expect(fallback).not.toHaveBeenCalled();
});

test('refuses errors and cancellation without an external kill', async () => {
  const fallback = vi.fn<() => boolean>(() => true);
  state.reply = { op: 'error', code: 'metro-changed' };
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toBe(false);
  state.reply = null;
  state.close = false;
  const controller = new AbortController();
  const stopping = stopMetroTree('/project', 42, 'token', fallback, controller.signal);
  controller.abort();
  expect(await stopping).toBe(false);
  expect(fallback).not.toHaveBeenCalled();
});
