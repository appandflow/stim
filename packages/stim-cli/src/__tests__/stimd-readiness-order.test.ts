import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';

const mock = vi.hoisted<{ replies: Array<(reply: object) => void>; sent: Array<{ params: { after: number } }> }>(
  () => ({ replies: [], sent: [] }),
);

vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  const { EventEmitter } = await import('node:events');
  class FakeSocket extends EventEmitter {
    setEncoding() {
      return this;
    }
    write(data: string) {
      const request = JSON.parse(data.trim().split('\n').at(-1) ?? '{}');
      mock.sent.push(request);
      mock.replies.push((reply) => this.emit('data', `{}\n${JSON.stringify(reply)}\n`));
      return true;
    }
    destroy() {
      return this;
    }
  }
  return {
    ...actual,
    connect: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
});

test('older readiness replies cannot replace newer coverage or move the revision backwards', async () => {
  const { deviceLogReadinessWait } = await import('../daemon/client.ts');
  const context = testContext();
  operationState(context).stimdOpToken = 'token';
  mock.replies.length = 0;
  mock.sent.length = 0;
  const wait = deviceLogReadinessWait('/workspace', 'ios', 'default', 'stream', 1, context);
  const old = wait(1000);
  await vi.waitFor(() => expect(mock.replies).toHaveLength(1));
  wait.coverThrough(10);
  const newer = wait(1000);
  await vi.waitFor(() => expect(mock.replies).toHaveLength(2));
  mock.replies[1]?.({ op: 'readiness.changed', revision: 5, coverage: 'failed' });
  await newer;
  mock.replies[0]?.({ op: 'readiness.changed', revision: 1, coverage: 'covered' });
  await old;
  expect(wait.coverage()).toBe('failed');
  const next = wait(1000);
  await vi.waitFor(() => expect(mock.replies).toHaveLength(3));
  expect(mock.sent[2]?.params.after).toBe(5);
  wait.coverThrough(20);
  mock.replies[2]?.({ op: 'readiness.changed', revision: 3, coverage: 'covered' });
  await next;
  expect(wait.coverage()).toBe('failed');
});
