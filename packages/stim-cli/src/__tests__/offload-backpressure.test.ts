import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { CipherState, NoiseTransport } from '@stim-cli/core/noise';
import { NoiseSocket, type RawSocket } from '@stim-cli/core/noise-session';
import { BuildConnection } from '../offload/client.ts';
import { testContext } from './_context.ts';

vi.mock('../offload/tailnet.ts', async (original) => ({
  ...(await original<typeof import('../offload/tailnet.ts')>()),
  openAuthenticated: async () => socket,
  sayHello: async () => ({ result: { capabilities: ['build'] } }),
}));

class BufferedSocket extends EventEmitter implements RawSocket {
  readyState = 1;
  bufferedAmount = 0;
  holdClose = false;
  pending: Array<(error?: Error) => void> = [];

  send(_data: Buffer | string, callback?: (error?: Error) => void): void {
    if (callback) this.pending.push(callback);
  }

  flush(error?: Error): void {
    this.bufferedAmount = 0;
    for (const callback of this.pending.splice(0)) callback(error);
  }

  close(code = 1000, reason = ''): void {
    if (this.holdClose) {
      this.readyState = 2;
      return;
    }
    this.readyState = 3;
    this.flush(new Error('The socket closed.'));
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    this.holdClose = false;
    this.close(1006);
  }
}

let directory: string;
let previousHome: string | undefined;
let raw: BufferedSocket;
let socket: NoiseSocket;
let connection: BuildConnection;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'stim-upload-backpressure-'));
  previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(directory, 'home');
  mkdirSync(process.env.STIM_HOME);
  raw = new BufferedSocket();
  socket = new NoiseSocket(
    raw,
    new NoiseTransport({
      send: new CipherState(Buffer.alloc(32, 1)),
      receive: new CipherState(Buffer.alloc(32, 2)),
      maxSendBytes: 65536,
      maxReceiveBytes: 65536,
    }),
    Buffer.alloc(32, 3),
  );
  const opened = await withAmbientContext(testContext(), () =>
    BuildConnection.open({ url: 'ws://127.0.0.1:1', host: 'localhost', servername: 'localhost' }, 'test-key', 1000),
  );
  if (!(opened instanceof BuildConnection)) throw new Error(opened.failure);
  connection = opened;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  connection.close();
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

test('local close releases a pressured sender before the peer completes the close handshake', async () => {
  raw.bufferedAmount = 9 * 1024 * 1024;
  raw.holdClose = true;
  let finished = false;
  const pending = connection.sendBinary(Buffer.from('queued bytes')).then(() => {
    finished = true;
    return null;
  });
  try {
    connection.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    expect(connection.failure).toContain('closed by this client');
  } finally {
    raw.terminate();
    await vi.advanceTimersByTimeAsync(5);
    await pending;
  }
});
