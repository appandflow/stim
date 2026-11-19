import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';

type Sent = { params: { after: number; checkCoverage: boolean; through: number } };

const mock = vi.hoisted<{
  replies: Array<(reply: object) => void>;
  sent: Sent[];
  onWrite: ((request: Sent, reply: (reply: object) => void, close: () => void) => void) | null;
}>(() => ({ replies: [], sent: [], onWrite: null }));

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
      const reply = (answer: object) => this.emit('data', `{}\n${JSON.stringify(answer)}\n`);
      mock.replies.push(reply);
      mock.onWrite?.(request, reply, () => this.emit('close'));
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

beforeEach(() => {
  mock.replies.length = 0;
  mock.sent.length = 0;
  mock.onWrite = null;
});

async function readinessWait() {
  const { deviceLogReadinessWait } = await import('../daemon/client.ts');
  const context = testContext();
  operationState(context).stimdOpToken = 'token';
  return deviceLogReadinessWait('/workspace', 'ios', 'default', 'stream', 1, context);
}

test('older readiness replies cannot replace newer coverage or move the revision backwards', async () => {
  const wait = await readinessWait();
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

test('a readiness connection that closes before any reply fails the coverage', async () => {
  mock.onWrite = (_request, _reply, close) => close();
  const wait = await readinessWait();
  const tick = wait(500);
  await vi.advanceTimersByTimeAsync(2000);
  await tick;
  expect(wait.coverage()).toBe('failed');
});

test('a launch verifies when every readiness reply takes longer than a poll', async () => {
  const { verifyLaunch } = await import('../engine/launch-verify.ts');
  mock.onWrite = (_request, reply) =>
    void setTimeout(() => reply({ op: 'readiness.changed', revision: 1, coverage: 'covered' }), 1700);
  const since = Date.now();
  const delivery = { src: 'metro', platform: 'ios', requestId: 'r1' };
  const metro = [
    { ...delivery, ts: since + 200, event: 'bundle_response_started' },
    { ...delivery, ts: since + 400, event: 'bundle_response_finished', statusCode: 200 },
  ];
  const verification = verifyLaunch({
    since,
    platform: 'ios',
    metroPort: 8081,
    requireBundleResponse: true,
    readRecords: () => metro.filter((record) => record.ts <= Date.now()),
    readDeviceRecords: () => [],
    readClientRecords: () => [],
    deviceStreamId: 'stream',
    processAlive: async () => true,
    sleep: await readinessWait(),
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await verification).toMatchObject({ verified: true });
});
