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
  }
  return { Worker };
});

import { createNetThread } from '../stimd/net.ts';

test('hosted drain requests reach the observer and return their acknowledgement', async () => {
  const drain = vi.fn<(session: string) => Promise<string | null>>().mockResolvedValue(null);
  const net = createNetThread(
    () => {},
    () => {},
    () => {},
    drain,
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
  await net.close();
});
