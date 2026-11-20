import { EventEmitter } from 'node:events';
import type { FromNet } from '../net-thread.ts';

const state = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
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
  serve: async () => ({ server: { addresses: [{ port: 1234 }] }, keep: () => {}, close: state.close }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  port.removeAllListeners();
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

test.each([true, false])('an aggregate is read-only only when every member is read-only: %s', async (readOnly) => {
  const child = { pid: 12345, command: 'ps -axo pid=' };
  state.close.mockRejectedValue(
    new AggregateError(
      [
        Object.assign(new Error('report child left'), { readOnly: true, reportChild: child }),
        Object.assign(
          new Error('other cleanup'),
          readOnly ? { readOnly: true, reportChild: { ...child, pid: 12346 } } : {},
        ),
      ],
      'Server resources did not close cleanly.',
    ),
  );
  await import('../net-thread.ts');
  port.emit('message', { type: 'stop' });
  await vi.waitFor(() => expect(state.end).toHaveBeenCalled());
  const closed = state.post.mock.calls.find(([message]) => message.type === 'closed')?.[0];
  if (closed?.type !== 'closed') throw new Error('net thread did not report close');
  expect(closed.readOnly).toBe(readOnly ? true : undefined);
  expect(closed.children).toEqual(readOnly ? [child, { ...child, pid: 12346 }] : undefined);
});
