import { createSocket } from '@/lib/socket';

/** Like the Nitro hybrid object: native reads the handler when the event fires and delivers it on a later JS task. */
class MockNative {
  static latest: MockNative;
  onOpen: (() => void) | undefined;
  onMessage: ((event: { data: ArrayBuffer; isBinary: boolean }) => void) | undefined;
  onClose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | undefined;
  onError: ((error: string) => void) | undefined;
  url = '';
  refuse = false;

  constructor() {
    MockNative.latest = this;
  }
  connect(url: string) {
    this.url = url;
    if (!this.refuse) return;
    const onClose = this.onClose;
    setTimeout(() => onClose?.({ code: 1006, reason: '', wasClean: false }), 0);
  }
  close() {}
  deliver(data: ArrayBuffer, isBinary: boolean) {
    this.onMessage?.({ data, isBinary });
  }
  closed(code: number) {
    this.onClose?.({ code, reason: '', wasClean: code !== 1006 });
  }
  failed() {
    this.onError?.('Socket is not connected');
  }
}

let mockRefuseNext = false;
jest.mock('react-native-nitro-websockets', () => ({
  createWebSocket: () => {
    const native = new MockNative();
    native.refuse = mockRefuseNext;
    return native;
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  mockRefuseNext = false;
});

it('reports a connection refused before the caller could set its handlers', async () => {
  mockRefuseNext = true;
  const socket = createSocket('ws://127.0.0.1:7787');
  const onclose = jest.fn();
  socket.onclose = onclose;
  await flush();
  expect(onclose).toHaveBeenCalledTimes(1);
});

it('delivers text as a string and binary as the received ArrayBuffer', () => {
  const socket = createSocket('ws://127.0.0.1:7787');
  const received: (string | ArrayBuffer)[] = [];
  socket.onmessage = (message) => received.push(message.data);
  const text = new TextEncoder().encode('{"event":"status","name":"caf\u00e9"}');
  const video = new Uint8Array([1, 0, 0, 21]).buffer;

  MockNative.latest.deliver(text.buffer, false);
  MockNative.latest.deliver(video, true);

  expect(received).toEqual(['{"event":"status","name":"caf\u00e9"}', video]);
  expect(received[1]).toBe(video);
});

it.each([
  ['an error without a close, as 1.3.1 reports a failed send on iOS', ['error']],
  ['an error and then a close, as Android reports a failure', ['error', 'close']],
  ['a close and then an error', ['close', 'error']],
])('reports one close for %s', (_name, events) => {
  const socket = createSocket('ws://127.0.0.1:7787');
  const onclose = jest.fn();
  socket.onclose = onclose;
  for (const event of events) {
    if (event === 'error') MockNative.latest.failed();
    else MockNative.latest.closed(1006);
  }
  expect(onclose).toHaveBeenCalledTimes(1);
});

it('reports only the close after the caller closed it, not an open or message the handshake still delivers', () => {
  const socket = createSocket('ws://127.0.0.1:7787');
  const seen: string[] = [];
  socket.onopen = () => seen.push('open');
  socket.onmessage = () => seen.push('message');
  socket.onclose = () => seen.push('close');
  socket.close();
  MockNative.latest.onOpen?.();
  MockNative.latest.deliver(new TextEncoder().encode('{}').buffer, false);
  MockNative.latest.closed(1000);
  expect(seen).toEqual(['close']);
});
