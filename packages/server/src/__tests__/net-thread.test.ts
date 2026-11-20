import { EventEmitter } from 'node:events';
import type { FromNet } from '../net-thread.ts';

const state = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  serve: vi.fn<() => Promise<unknown>>(),
  post: vi.fn<(message: FromNet) => void>(),
  end: vi.fn<() => void>(),
}));
const port = new EventEmitter();
vi.mock('node:worker_threads', () => ({
  isMainThread: false,
  parentPort: Object.assign(port, { postMessage: state.post, close: state.end }),
  workerData: { net: { port: 0 } },
}));
vi.mock('../cli.ts', () => ({
  NetRefusal: class extends Error {},
  serve: state.serve,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  port.removeAllListeners();
  state.serve.mockResolvedValue({ server: { addresses: [{ port: 1234 }] }, keep: () => {}, close: state.close });
});

test('a failed start reports every aggregate member to stimd', async () => {
  state.serve.mockRejectedValue(
    new AggregateError(
      [new Error('listen failed'), new Error('startup cleanup unverified')],
      'server startup cleanup could not be verified',
    ),
  );
  await import('../net-thread.ts');
  await vi.waitFor(() => expect(state.end).toHaveBeenCalled());
  const refused = state.post.mock.calls.find(([message]) => message.type === 'refused')?.[0];
  if (refused?.type !== 'refused') throw new Error('net thread did not refuse');
  expect(refused.message).toContain('listen failed');
  expect(refused.message).toContain('startup cleanup unverified');
});

test('a failed close reports every aggregate member to stimd', async () => {
  state.close.mockRejectedValue(
    new AggregateError(
      [
        new Error('build cleanup failed'),
        new AggregateError([new Error('hosted device still running')], 'hosted cleanup failed'),
      ],
      'Server resources did not close cleanly.',
    ),
  );
  await import('../net-thread.ts');
  port.emit('message', { type: 'stop' });
  await vi.waitFor(() => expect(state.end).toHaveBeenCalled());
  expect(state.post).toHaveBeenCalledWith({
    type: 'closed',
    error: expect.stringContaining('Server resources did not close cleanly.'),
  });
  const closed = state.post.mock.calls.find(([message]) => message.type === 'closed')?.[0];
  if (closed?.type !== 'closed') throw new Error('net thread did not report close');
  expect(closed.error).toContain('build cleanup failed');
  expect(closed.error).toContain('hosted cleanup failed');
  expect(closed.error).toContain('hosted device still running');
});
