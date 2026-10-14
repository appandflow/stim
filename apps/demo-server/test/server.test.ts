import { generateNoiseKeyPair } from '@stim-cli/core/noise';

import { HANDSHAKE_MS } from '../src/demo.ts';
import { DemoServer } from '../src/index.ts';

vi.mock('../src/fixtures.ts', () => ({
  bundledFixtures: () => ({ capturedAt: new Date().toISOString(), logs: [], frames: {} }),
}));

interface StubSocket {
  readyState: number;
  attachment: unknown;
  close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
}

function stubSocket(attachment: unknown = null): StubSocket & WebSocket {
  const socket = {
    readyState: 1,
    attachment,
    close: vi.fn<(code?: number, reason?: string) => void>(() => {
      socket.readyState = 3;
    }),
    send: () => {},
    serializeAttachment: (value: unknown) => {
      socket.attachment = value;
    },
    deserializeAttachment: () => socket.attachment,
  };
  return socket as unknown as StubSocket & WebSocket;
}

const upgrade = new Request('http://demo.example/', { headers: { Upgrade: 'websocket' } });

type Stub = StubSocket & WebSocket;

function server(): { durable: DemoServer; open: () => Stub } {
  const store = new Map<string, unknown>([['identity', new Uint8Array(generateNoiseKeyPair().privateKey)]]);
  const accepted: Stub[] = [];
  const ctx = {
    storage: {
      kv: { get: (key: string) => store.get(key), put: (key: string, value: unknown) => store.set(key, value) },
    },
    getWebSockets: () => accepted,
    acceptWebSocket: (socket: Stub) => accepted.push(socket),
  };
  const [state, env] = [ctx, {}] as unknown as ConstructorParameters<typeof DemoServer>;
  const durable = new DemoServer(state, env);
  return {
    durable,
    open: () => {
      durable.fetch(upgrade);
      return accepted.at(-1) ?? stubSocket();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocketPair', function WebSocketPair() {
    return [stubSocket(), stubSocket()];
  });
  vi.stubGlobal('Response', function Response(_body: unknown, init: ResponseInit) {
    return { ...init };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('closes a socket that sends nothing within the handshake deadline, and keeps one that started', () => {
  const { durable, open } = server();
  const silent = open();
  const started = open();
  durable.webSocketMessage(started, new Uint8Array([2, 0, ...new Uint8Array(32)]).buffer);
  vi.advanceTimersByTime(HANDSHAKE_MS - 1);
  expect(silent.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(silent.close).toHaveBeenCalledWith(4401, 'timeout');
  expect(started.close).not.toHaveBeenCalledWith(4401, 'timeout');
});

it('closes a paired socket with 1012 when its first message arrives after hibernation', () => {
  const { durable } = server();
  const woken = stubSocket(true);
  durable.webSocketMessage(woken, new Uint8Array([1]).buffer);
  expect(woken.close).toHaveBeenCalledWith(1012, 'restarted');
});
