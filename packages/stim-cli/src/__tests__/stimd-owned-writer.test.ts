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
    }
    postMessage(message: unknown) {
      this.sent.push(message);
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return { Worker };
});

import { createLogWriters } from '../stimd/logs/writer.ts';

test('an empty worker error rejects an owned drain request', async () => {
  const writers = createLogWriters(() => {});
  try {
    const pending = writers.ownedDrain('root');
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
