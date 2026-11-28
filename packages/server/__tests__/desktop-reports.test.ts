import { DesktopReports, GC_REPORT_STALE_MS } from '../src/desktop-reports.ts';
import type { DetailsRead } from '../src/machine-details.ts';
import type { DesktopReportSnapshot, DesktopReportTarget } from '../src/protocol.ts';

const caches: DesktopReports[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  vi.clearAllTimers();
});

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

const TARGET: DesktopReportTarget = { report: 'doctor', cwd: '/app' };
const GC: DesktopReportTarget = { report: 'gc' };

test('invalidation joins a fresh read and never publishes an obsolete completion', async () => {
  const old = deferred<DetailsRead>();
  const fresh = deferred<DetailsRead>();
  let reads = 0;
  const snapshots: DesktopReportSnapshot[] = [];
  const cache = new DesktopReports(() => (++reads === 1 ? old.promise : fresh.promise));
  caches.push(cache);
  const before = cache.get(TARGET);
  cache.subscribe(TARGET, (snapshot) => snapshots.push(snapshot));
  cache.invalidate();
  const after = cache.get(TARGET);
  old.resolve({ ok: true, report: { version: 1 } });
  fresh.resolve({ ok: true, report: { version: 2 } });
  const results = await Promise.all([before, after]);
  expect(results.map((result) => result.value)).toEqual([{ version: 2 }, { version: 2 }]);
  expect(reads).toBe(2);
  expect(snapshots.map((snapshot) => ({ pending: snapshot.pending, value: snapshot.value }))).toEqual([
    { pending: true, value: null },
    { pending: false, value: { version: 2 } },
  ]);
});

test('cancelling one reader leaves the shared report available to another', async () => {
  const reply = deferred<DetailsRead>();
  const controller = new AbortController();
  const cache = new DesktopReports(() => reply.promise);
  caches.push(cache);
  const first = cache.get(TARGET, controller.signal);
  const other = cache.get(TARGET);
  const reason = new Error('client left');
  controller.abort(reason);
  await expect(first).rejects.toBe(reason);
  reply.resolve({ ok: true, report: { version: 7 } });
  expect((await other).value).toEqual({ version: 7 });
});

test('only active subscribers refresh on expiry, and close stops scheduled reads', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const snapshots: DesktopReportSnapshot[] = [];
  const cache = new DesktopReports(async () => ({ ok: true, report: { version: ++reads } }), 100);
  caches.push(cache);
  const stop = cache.subscribe(TARGET, (snapshot) => snapshots.push(snapshot));
  await cache.get(TARGET);
  await vi.advanceTimersByTimeAsync(100);
  expect(snapshots.at(-1)?.value).toEqual({ version: 2 });
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(2);
  expect((await cache.get(TARGET)).value).toEqual({ version: 3 });
  cache.subscribe(TARGET, (snapshot) => snapshots.push(snapshot));
  cache.invalidate();
  cache.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(3);
  expect((await cache.get(TARGET)).error).toBeDefined();
});

test('unsubscribing cannot free a probe slot before the shared work drains', async () => {
  const loads: ReturnType<typeof deferred<DetailsRead>>[] = [];
  const snapshots: DesktopReportSnapshot[] = [];
  const cache = new DesktopReports(() => {
    const load = deferred<DetailsRead>();
    loads.push(load);
    return load.promise;
  });
  caches.push(cache);
  for (let i = 0; i < 40; i++)
    cache.subscribe({ report: 'doctor', cwd: `/app-${i}` }, (snapshot) => snapshots.push(snapshot))();
  await Promise.resolve();
  expect(loads).toHaveLength(4);
  expect((await cache.get({ report: 'doctor', cwd: '/overflow' })).error).toContain('4 shared reports');
  loads[0]?.resolve({ ok: true, report: { version: 1 } });
  await cache.get({ report: 'doctor', cwd: '/app-0' });
  const next = cache.get({ report: 'doctor', cwd: '/available' });
  await Promise.resolve();
  expect(loads).toHaveLength(5);
  for (const load of loads) load.resolve({ ok: true, report: { version: 2 } });
  expect((await next).value).toEqual({ version: 2 });
});

test('reclaims abandoned first reads after invalidation and unsubscribe', async () => {
  const loads: ReturnType<typeof deferred<DetailsRead>>[] = [];
  const cache = new DesktopReports(() => {
    const load = deferred<DetailsRead>();
    loads.push(load);
    return load.promise;
  });
  caches.push(cache);
  for (let i = 0; i < 8; i++) {
    const stop = cache.subscribe({ report: 'doctor', cwd: `/abandoned-${i}` }, () => {});
    await Promise.resolve();
    cache.invalidate();
    stop();
    loads.at(-1)?.resolve({ ok: true, report: { version: 1 } });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const final = cache.get(TARGET);
  await Promise.resolve();
  loads.at(-1)?.resolve({ ok: true, report: { version: 2 } });
  await final;
  expect(cache).toHaveProperty('entries.size', 1);
});

test('invalidation aborts the stale load so a waiting get takes only the fresh one', async () => {
  const signals: AbortSignal[] = [];
  const fresh = deferred<DetailsRead>();
  const cache = new DesktopReports((_target, signal) => {
    signals.push(signal);
    if (signals.length > 1) return fresh.promise;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve({ ok: false, message: 'aborted' }), { once: true }),
    );
  });
  caches.push(cache);
  const waiting = cache.get(TARGET);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  cache.invalidate();
  expect(signals[0]?.aborted).toBe(true);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  fresh.resolve({ ok: true, report: { version: 2 } });
  expect((await waiting).value).toEqual({ version: 2 });
});

test('the gc report answers from its cache at once, refreshes when stale, and an invalidation joins the read', async () => {
  vi.useFakeTimers({ now: 10 * GC_REPORT_STALE_MS });
  const loads: { load: ReturnType<typeof deferred<DetailsRead>>; signal: AbortSignal }[] = [];
  const seededAt = Date.now() - GC_REPORT_STALE_MS;
  const cache = new DesktopReports(
    (_target, signal) => {
      const load = deferred<DetailsRead>();
      loads.push({ load, signal });
      return load.promise;
    },
    undefined,
    undefined,
    () => ({ value: { version: 1 }, at: seededAt }),
  );
  caches.push(cache);
  expect(await cache.get(GC)).toEqual({
    pending: false,
    value: { version: 1 },
    measuredAt: new Date(seededAt).toISOString(),
    refreshing: true,
  });
  cache.invalidate(GC);
  cache.invalidate();
  expect(loads).toHaveLength(1);
  expect(loads[0]?.signal.aborted).toBe(false);
  const startedAt = Date.now();
  await vi.advanceTimersByTimeAsync(60_000);
  loads[0]?.load.resolve({ ok: true, report: { version: 2 } });
  await vi.waitFor(async () => expect((await cache.get(GC)).value).toEqual({ version: 2 }));
  expect(await cache.get(GC)).toEqual({
    pending: false,
    value: { version: 2 },
    measuredAt: new Date(startedAt).toISOString(),
  });
  expect(loads).toHaveLength(1);
  cache.invalidate(GC);
  await vi.waitFor(() => expect(loads).toHaveLength(2));
});

test('a failed gc refresh keeps the last good report, and with none says it is not measured yet', async () => {
  vi.useFakeTimers({ now: 10 * GC_REPORT_STALE_MS });
  const replies: DetailsRead[] = [
    { ok: false, message: 'first failed' },
    { ok: true, report: { version: 1 } },
    { ok: false, message: 'later failed' },
  ];
  const cache = new DesktopReports(async () => replies.shift()!);
  caches.push(cache);
  expect(await cache.get(GC)).toEqual({ pending: true, value: null, refreshing: true });
  await vi.waitFor(async () => expect((await cache.get(GC)).error).toBe('first failed'));
  expect(await cache.get(GC)).toEqual({ pending: true, value: null, error: 'first failed' });
  cache.invalidate(GC);
  await vi.waitFor(async () => expect((await cache.get(GC)).value).toEqual({ version: 1 }));
  cache.invalidate(GC);
  await vi.waitFor(async () => expect((await cache.get(GC)).error).toBe('later failed'));
  expect((await cache.get(GC)).value).toEqual({ version: 1 });
});
