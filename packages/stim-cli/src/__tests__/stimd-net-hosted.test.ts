const state = vi.hoisted(() => ({
  worker: null as null | { emit: (event: string, value: unknown) => void; sent: unknown[] },
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    sent: unknown[] = [];
    constructor() {
      super();
      state.worker = this;
      queueMicrotask(() => this.emit('message', { type: 'listening', port: 1234 }));
    }
    postMessage(message: unknown) {
      this.sent.push(message);
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop')
        queueMicrotask(() => {
          this.emit('message', { type: 'closed' });
          this.emit('exit', 0);
        });
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return { Worker };
});

import { createNetThread } from '../stimd/net.ts';
import { createLogWriters } from '../stimd/logs/writer.ts';

test('hosted drain requests reach the observer and return their acknowledgement', async () => {
  const drain = vi.fn<(session: string) => Promise<string | null>>().mockResolvedValue(null);
  const observe = vi
    .fn<(session: string, pid: number, token: string, launchId: string) => Promise<string | null>>()
    .mockResolvedValue(null);
  const net = createNetThread(
    () => {},
    () => {},
    () => {},
    drain,
    observe,
  );
  await net.ensure({
    port: 0,
    extraEnv: [],
    pathPrepend: [],
    loopbackOnly: true,
    shareOnly: false,
    desktopKey: '',
    script: '',
  });
  const worker = state.worker;
  if (!worker) throw new Error('the net thread did not start');
  worker.emit('message', { type: 'hosted-drain', id: 7, session: 'session' });
  await vi.waitFor(() => expect(worker.sent).toContainEqual({ type: 'hosted-drained', id: 7, error: null }));
  expect(drain).toHaveBeenCalledWith('session');
  worker.emit('message', {
    type: 'hosted-observe',
    id: 8,
    session: 'session',
    pid: 42,
    token: 'token',
    launchId: 'launch',
  });
  await vi.waitFor(() => expect(worker.sent).toContainEqual({ type: 'hosted-observed', id: 8, error: null }));
  expect(observe).toHaveBeenCalledWith('session', 42, 'token', 'launch');
  await net.close();
});

test('an empty worker error rejects a hosted drain request', async () => {
  const writers = createLogWriters(() => {});
  try {
    const pending = writers.ownedDrainHosted('session');
    const worker = state.worker;
    if (!worker) throw new Error('the logs worker did not start');
    const request = worker.sent[0] as { requestId: number };
    worker.emit('message', { requestId: request.requestId, error: '' });
    await expect(pending).rejects.toBeInstanceOf(Error);
  } finally {
    await writers.close();
  }
});

test('owned shutdown waits for the log worker acknowledgement', async () => {
  const writers = createLogWriters(() => {});
  try {
    let settled = false;
    const pending = writers.ownedClose().then(() => {
      settled = true;
      return undefined;
    });
    const worker = state.worker;
    if (!worker) throw new Error('the logs worker did not start');
    const request = worker.sent[0] as { requestId: number };
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit('message', { requestId: request.requestId, error: null });
    await pending;
    expect(settled).toBe(true);
  } finally {
    await writers.close();
  }
});
