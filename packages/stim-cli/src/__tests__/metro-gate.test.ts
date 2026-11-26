import { gateMetroOrigin, REMOTE_METRO_WRONG } from '../engine/metro-gate.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { resolve4 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn<typeof resolve4>() }));
vi.mock('node:https', () => ({ request: vi.fn<typeof httpsRequest>() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(resolve4).mockReset();
  vi.mocked(httpsRequest).mockReset();
});

const ORIGIN = 'https://abc.trycloudflare.com';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function gate(over: Partial<Parameters<typeof gateMetroOrigin>[0]> = {}) {
  const c = clock();
  return gateMetroOrigin({
    origin: ORIGIN,
    metroPort: 8085,
    platform: 'ios',
    readRecords: () => [],
    isProof: () => false,
    probe: async () => 200,
    now: c.now,
    sleep: c.sleep,
    ...over,
  });
}

describe('the proof is a request arriving in THIS workspace log', () => {
  test('a bundle event after the probe started passes the gate', async () => {
    const records: NdjsonRecord[] = [{ ts: 5_000, src: 'metro', level: 'info', msg: 'bundle' }];
    const result = await gate({ readRecords: () => records, isProof: (r) => (r.ts ?? 0) === 5_000 });
    expect(result.ok).toBe(true);
  });

  test.each([200, 404])('a foreign server answering %s is refused without retrying', async (status) => {
    const probe = vi.fn<() => Promise<number>>(async () => status);
    const result = await gate({ probe, isProof: () => false });
    expect(probe).toHaveBeenCalledOnce();
    expect(result.failed).toBe(true);
    expect(result.code).toBe(REMOTE_METRO_WRONG);
    expect(result.reason).toContain('different dev server');
  });
});

describe('failing closed', () => {
  test('a pending DNS lookup ends when the gate deadline aborts it', async () => {
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }),
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(fetchError));
    vi.mocked(resolve4).mockImplementation(() => new Promise<string[]>(() => {}));

    const pending = gateMetroOrigin({
      origin: ORIGIN,
      metroPort: 8085,
      platform: 'ios',
      readRecords: () => [],
      isProof: () => false,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      timeoutMs: 20,
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('did not answer');
    expect(resolve4).toHaveBeenCalledOnce();
  });

  test('a probe that throws is still a refusal, never a pass', async () => {
    const result = await gate({
      probe: async () => {
        throw new Error('network down');
      },
    });
    expect(result.failed).toBe(true);
  });
});

test.each(['hung', '530'] as const)('retries a %s probe so later workspace proof can pass', async (failure) => {
  let reachedMetro = false;
  const signals: AbortSignal[] = [];
  const probe = vi.fn<(url: string, signal: AbortSignal) => Promise<number | null>>(async (_url, signal) => {
    signals.push(signal);
    if (signals.length === 1) {
      if (failure === '530') return 530;
      return new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
    }
    reachedMetro = true;
    return 200;
  });
  const pending = gateMetroOrigin({
    origin: ORIGIN,
    metroPort: 8085,
    platform: 'ios',
    readRecords: () => (reachedMetro ? [{ ts: Date.now(), src: 'metro', level: 'info', msg: 'bundle' }] : []),
    isProof: () => true,
    probe,
  });
  await vi.advanceTimersByTimeAsync(failure === 'hung' ? 9_500 : 1_500);
  expect(await pending).toEqual({ ok: true });
  expect(probe).toHaveBeenCalledTimes(2);
  expect(signals[0]?.aborted).toBe(true);
});

test('uses the managed tunnel remedy', async () => {
  const result = await gate({ managed: true });
  expect(result.remedy).toBe(
    'Stim started this tunnel; it may still be registering. Run the same command again. If it fails again, run `stim stop` and retry, which starts a new tunnel.',
  );
});

test('keeps the manual tunnel remedy by default', async () => {
  const result = await gate();
  expect(result.remedy).toContain('rebuild a manual tunnel');
});

test('a retry the deadline cuts off keeps the last answered status', async () => {
  const probe = vi.fn<(url: string, signal: AbortSignal) => Promise<number | null>>(async (_url, signal) =>
    probe.mock.calls.length === 1
      ? 530
      : new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
  );
  const pending = gateMetroOrigin({
    origin: ORIGIN,
    metroPort: 8085,
    platform: 'ios',
    readRecords: () => [],
    isProof: () => false,
    probe,
    timeoutMs: 5_000,
  });
  await vi.advanceTimersByTimeAsync(6_000);
  const result = await pending;
  expect(probe).toHaveBeenCalledTimes(2);
  expect(result.reason).toContain('answered 530');
});

test('a refusal describes the last probe response', async () => {
  const probe = vi.fn<() => Promise<number>>(async () => 502).mockResolvedValueOnce(530);
  const result = await gate({ probe });
  expect(probe.mock.calls.length).toBeGreaterThan(1);
  expect(result.reason).toContain('answered 502');
});
