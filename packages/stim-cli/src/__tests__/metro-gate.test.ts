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

  test('a HEALTHY foreign server is refused -- liveness is not identity', async () => {
    const result = await gate({ probe: async () => 200, isProof: () => false });
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

    const result = await gateMetroOrigin({
      origin: ORIGIN,
      metroPort: 8085,
      platform: 'ios',
      readRecords: () => [],
      isProof: () => false,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      timeoutMs: 20,
    });

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
