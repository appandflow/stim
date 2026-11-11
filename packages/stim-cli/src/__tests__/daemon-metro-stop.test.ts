const state = vi.hoisted(() => {
  const result: {
    reply: Record<string, unknown> | null;
    refuse: boolean;
    refusal: Record<string, unknown>;
    daemon: boolean;
    close: boolean;
    live: unknown[];
    unresolved: unknown[];
    daemonLive: unknown[] | undefined;
  } = {
    reply: null,
    refuse: false,
    refusal: {},
    daemon: true,
    close: true,
    live: [],
    unresolved: [],
    daemonLive: undefined,
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
          if (state.refuse) {
            this.emit('data', `${JSON.stringify({ op: 'engine-changed', build: 'otherbuild00', ...state.refusal })}\n`);
            this.emit('close');
          } else if (state.reply)
            this.emit('data', `${JSON.stringify({ op: 'hello' })}\n${JSON.stringify(state.reply)}\n`);
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
  readClaimSet: (root: string) =>
    root.includes('metro.claim') || state.daemon
      ? {
          live: root.includes('metro.claim') ? state.live : (state.daemonLive ?? state.live),
          unresolved: state.unresolved,
        }
      : { live: [], unresolved: [] },
}));

import { stopMetroTree } from '../daemon/client.ts';

beforeEach(() => {
  state.reply = null;
  state.refuse = false;
  state.refusal = {};
  state.daemon = true;
  state.close = true;
  state.live = [{ path: '/home/workspaces/w/metro.claim/exclusive/a.claim' }];
  state.unresolved = [];
  state.daemonLive = undefined;
});

test('uses the acknowledged managed stop without invoking the fallback', async () => {
  state.reply = { op: 'metro.stopped', state: 'stopped' };
  const fallback = vi.fn<() => boolean>(() => true);
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toEqual({ stopped: true });
  expect(fallback).not.toHaveBeenCalled();
});

test('falls back on explicit not-owned or absent daemon and claims', async () => {
  const fallback = vi.fn<() => boolean>(() => true);
  state.reply = { op: 'metro.stopped', state: 'not-owned' };
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toEqual({ stopped: true });
  state.reply = null;
  state.live = [];
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toEqual({ stopped: true });
  expect(fallback).toHaveBeenCalledTimes(2);
});

test.each(['live', 'unresolved'])('refuses an unanswered stop with %s claims', async (kind) => {
  if (kind === 'unresolved') {
    state.live = [];
    state.unresolved = [{}];
  }
  const fallback = vi.fn<() => boolean>(() => true);
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toMatchObject({ stopped: false });
  expect(fallback).not.toHaveBeenCalled();
});

test('refuses errors and cancellation without an external kill', async () => {
  const fallback = vi.fn<() => boolean>(() => true);
  state.reply = { op: 'error', code: 'metro-changed' };
  expect(await stopMetroTree('/project', 42, 'token', fallback)).toMatchObject({ stopped: false });
  state.reply = null;
  state.close = false;
  const controller = new AbortController();
  const stopping = stopMetroTree('/project', 42, 'token', fallback, controller.signal);
  controller.abort();
  expect(await stopping).toMatchObject({ stopped: false });
  expect(fallback).not.toHaveBeenCalled();
});

test('on Windows, where no stimd adopts, a Metro whose stimd exited stops through its recorded tree', async () => {
  state.daemon = false;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const fallback = vi.fn<() => boolean>(() => true);
    expect(await stopMetroTree('/project', 42, 'token', fallback)).toEqual({ stopped: true });
    expect(fallback).toHaveBeenCalledOnce();
    expect(await stopMetroTree('/project', 42, 'token', () => false)).toMatchObject({
      stopped: false,
      remedy: expect.stringContaining("rm -f '/home/workspaces/w/metro.claim/exclusive/a.claim'"),
    });
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});

test('an unanswered stop names the Metro claim and the command that removes it', async () => {
  const stopped = await stopMetroTree('/project', 42, 'token', () => true);
  expect(stopped).toMatchObject({
    stopped: false,
    remedy: expect.stringContaining("rm -f '/home/workspaces/w/metro.claim/exclusive/a.claim'"),
  });
});

test('an unanswered stop under an unresolved stimd claim names that claim, not the Metro claim', async () => {
  state.daemonLive = [{ path: '/home/stimd.claim/exclusive/d.claim' }];
  const fallback = vi.fn<() => boolean>(() => true);
  const stopped = await stopMetroTree('/project', 42, 'token', fallback);
  expect(stopped).toMatchObject({
    stopped: false,
    reason: expect.stringContaining('/home/stimd.claim/exclusive/d.claim'),
    remedy: expect.stringContaining("rm -f '/home/stimd.claim/exclusive/d.claim'"),
  });
  expect(fallback).not.toHaveBeenCalled();
});

test('leaves a Metro claimed under a stimd of another build to that build, naming it', async () => {
  state.refuse = true;
  const fallback = vi.fn<() => boolean>(() => true);
  const stopping = stopMetroTree('/project', 42, 'token', fallback);
  await vi.advanceTimersByTimeAsync(6000);
  expect(await stopping).toMatchObject({ stopped: false, remedy: expect.stringContaining('otherbuild00') });
  expect(fallback).not.toHaveBeenCalled();
});

test('a stimd of another build whose handover live shares hold names them at once, as other commands do', async () => {
  state.refuse = true;
  state.refusal = { handover: true, heldBy: 'shares', pid: 4242 };
  const stopped = await stopMetroTree('/project', 42, 'token', () => true);
  expect(stopped).toMatchObject({
    stopped: false,
    reason: expect.stringContaining('live web shares'),
    remedy: expect.stringContaining('kill 4242'),
  });
});
