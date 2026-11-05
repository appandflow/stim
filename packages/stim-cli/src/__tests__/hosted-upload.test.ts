import { HOSTED_APP_CHUNK_BYTES } from '@stim-cli/core/state';
import { BuildConnection } from '../offload/client.ts';
import { upload, type HostConnection } from '../device-host/hosted-client.ts';

interface Chunk {
  sha256: string;
  offset: number;
  data: string;
}

function fakeHost(options: { refuseAt?: number } = {}): {
  host: HostConnection;
  received: Map<string, Buffer>;
  sent: () => number;
  peak: () => number;
} {
  const received = new Map<string, Buffer>();
  let sent = 0;
  let active = 0;
  let peak = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const request = (method: string, chunk: Chunk) => {
    const index = ++sent;
    active++;
    peak = Math.max(peak, active);
    const reply = queue.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (method !== 'device-host.app.chunk') return { error: { code: 'unknown-method', message: method } };
      if (index === options.refuseAt) return { error: { code: 'bad-request', message: 'refused' } };
      const bytes = Buffer.from(chunk.data, 'base64');
      const current = received.get(chunk.sha256) ?? Buffer.alloc(0);
      if (chunk.offset !== current.length)
        return { error: { code: 'bad-request', message: `Resume this file at byte ${current.length}.` } };
      const next = Buffer.concat([current, bytes]);
      received.set(chunk.sha256, next);
      return { result: { offset: next.length } };
    });
    queue = reply;
    return reply;
  };
  const connection: BuildConnection = Object.create(BuildConnection.prototype);
  connection.request = async (method, params) => request(method, JSON.parse(JSON.stringify(params)));
  const host: HostConnection = {
    machine: 'mini',
    credential: {
      machine: 'mini',
      transport: 'tailscale',
      address: 'mini.tail.ts.net',
      deviceId: 'client',
      serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
      state: 'approved',
      requestedAt: '2026-10-09T00:00:00Z',
    },
    connection,
  };
  return {
    host,
    received,
    sent: () => sent,
    peak: () => peak,
  };
}

const ids = { session: 's', attempt: 'a' };
const bytesOf = (size: number, seed: number): Buffer =>
  Buffer.from(Array.from({ length: size }, (_, i) => (i * seed) % 251));

test('delivers every file byte-exact without waiting for each reply, and resumes at the host offset', async () => {
  const big = bytesOf(HOSTED_APP_CHUNK_BYTES * 20 + 123, 7);
  const small = bytesOf(40, 3);
  const empty = Buffer.alloc(0);
  const resumed = bytesOf(HOSTED_APP_CHUNK_BYTES * 3 + 5, 11);
  const fake = fakeHost();
  fake.received.set('resumed', resumed.subarray(0, HOSTED_APP_CHUNK_BYTES));
  const delivered = upload(
    fake.host,
    ids,
    [
      { sha256: 'big', offset: 0 },
      { sha256: 'small', offset: 0 },
      { sha256: 'empty', offset: 0 },
      { sha256: 'resumed', offset: HOSTED_APP_CHUNK_BYTES },
    ],
    new Map([
      ['big', () => big],
      ['small', () => small],
      ['empty', () => empty],
      ['resumed', () => resumed],
    ]),
  );
  await vi.runAllTimersAsync();
  await delivered;
  expect(fake.received.get('big')?.equals(big)).toBe(true);
  expect(fake.received.get('small')?.equals(small)).toBe(true);
  expect(fake.received.get('empty')?.length).toBe(0);
  expect(fake.received.get('resumed')?.equals(resumed)).toBe(true);
  expect(fake.peak()).toBeGreaterThan(8);
});

test('stops sending and reports the first refused chunk', async () => {
  const fake = fakeHost({ refuseAt: 3 });
  const big = bytesOf(HOSTED_APP_CHUNK_BYTES * 300, 5);
  const refused = upload(fake.host, ids, [{ sha256: 'big', offset: 0 }], new Map([['big', () => big]])).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(await refused).toMatchObject({
    message: expect.stringContaining('mini refused device-host.app.chunk: refused'),
  });
  expect(fake.sent()).toBeLessThan(150);
});
