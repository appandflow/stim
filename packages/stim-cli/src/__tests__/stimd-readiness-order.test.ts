import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';
import type { NdjsonRecord } from '../ndjson.ts';

type Sent = { params: { after: number; checkCoverage: boolean; through: number; timeoutMs: number } };

const mock = vi.hoisted<{
  replies: Array<(reply: object) => void>;
  sent: Sent[];
  open: Set<object>;
  onWrite: ((request: Sent, reply: (reply: object) => void, close: () => void) => void) | null;
}>(() => ({ replies: [], sent: [], open: new Set(), onWrite: null }));

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
      mock.open.delete(this);
      return this;
    }
  }
  return {
    ...actual,
    connect: () => {
      const socket = new FakeSocket();
      mock.open.add(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
});

beforeEach(() => {
  mock.replies.length = 0;
  mock.sent.length = 0;
  mock.open.clear();
  mock.onWrite = null;
});

async function readinessWait() {
  const { deviceLogReadinessWait } = await import('../daemon/client.ts');
  const context = testContext();
  operationState(context).stimdOpToken = 'token';
  return deviceLogReadinessWait('/workspace', 'ios', 'default', 'stream', 1, context);
}

async function verifyIosLaunch(
  sleep: Awaited<ReturnType<typeof readinessWait>>,
  device: (since: number) => NdjsonRecord[] = () => [],
  processAlive: (since: number) => Promise<boolean> = async () => true,
) {
  const { verifyLaunch } = await import('../engine/launch-verify.ts');
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
    readDeviceRecords: () => device(since),
    readClientRecords: () => [],
    deviceStreamId: 'stream',
    processAlive: () => processAlive(since),
    sleep,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  return verification;
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
  await vi.advanceTimersByTimeAsync(1000);
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

test('a reply that changes nothing still waits out the poll', async () => {
  mock.onWrite = (_request, reply) => reply({ op: 'readiness.changed', revision: 0, coverage: 'pending' });
  const wait = await readinessWait();
  const polls: number[] = [];
  for (let poll = 0; poll < 4; poll++) {
    const started = Date.now();
    const tick = wait(500).then(() => polls.push(Date.now() - started));
    await vi.advanceTimersByTimeAsync(500);
    await tick;
  }
  expect(polls).toEqual([500, 500, 500, 500]);
  expect(mock.sent).toHaveLength(4);
});

test('one readiness request spans polls up to its cap, and stimd may use that budget', async () => {
  const wait = await readinessWait();
  for (let elapsed = 0; elapsed < 32_000; elapsed += 500) {
    const tick = wait(500);
    await vi.advanceTimersByTimeAsync(500);
    await tick;
  }
  expect(wait.coverage()).toBe('pending');
  expect(mock.sent).toHaveLength(2);
  expect(mock.sent[0]?.params.timeoutMs).toBe(30_000);
  expect(mock.open.size).toBe(1);
  wait.close();
  expect(mock.open.size).toBe(0);
});

test('a launch verifies when every readiness reply takes longer than a poll', async () => {
  mock.onWrite = (_request, reply) =>
    void setTimeout(() => reply({ op: 'readiness.changed', revision: 1, coverage: 'covered' }), 1700);
  expect(await verifyIosLaunch(await readinessWait())).toMatchObject({ verified: true });
  expect(mock.open.size).toBe(0);
});

test('a launch that stimd never answers ends unverified and closes its readiness request', async () => {
  expect(await verifyIosLaunch(await readinessWait())).toMatchObject({ verified: false, timedOut: true });
  expect(mock.sent.length).toBeGreaterThan(0);
  expect(mock.open.size).toBe(0);
});

test.each([
  ['no JavaScript start', false],
  ['an earlier JavaScript start', true],
])(
  'coverage proven during a probe that ends past the deadline verifies the launch, read again with %s',
  async (_, running) => {
    const wait = await readinessWait();
    let proven = false;
    let probed = false;
    const result = await verifyIosLaunch(
      wait,
      (since) =>
        running && proven
          ? [
              {
                ts: since + 1000,
                src: 'device',
                platform: 'ios',
                level: 'info',
                streamId: 'stream',
                msg: 'Running "main"',
              },
            ]
          : [],
      async (since) => {
        if (probed || Date.now() < since + 19_000) return true;
        probed = true;
        setTimeout(
          () => {
            proven = true;
            mock.replies.at(-1)?.({ op: 'readiness.changed', revision: 1, coverage: 'covered' });
          },
          since + 19_710 - Date.now(),
        );
        await new Promise((done) => setTimeout(done, since + 20_300 - Date.now()));
        return true;
      },
    );
    expect(probed).toBe(true);
    expect(result).toMatchObject({ verified: true, ...(running ? { jsRunning: true } : {}) });
  },
);
