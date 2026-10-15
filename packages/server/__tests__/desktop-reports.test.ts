import { DesktopReports } from '../src/desktop-reports.ts';
import type { DetailsRead } from '../src/machine-details.ts';
import type { DesktopReportSnapshot, DesktopReportTarget } from '../src/protocol.ts';

const caches: DesktopReports[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

const TARGET: DesktopReportTarget = { report: 'doctor', cwd: '/app' };

test('shares a report until expiry and keeps different project folders separate', async () => {
  let now = 0;
  let version = 1;
  const reads: DesktopReportTarget[] = [];
  const cache = new DesktopReports(
    async (target) => {
      reads.push(target);
      return { ok: true, report: { version } };
    },
    100,
    () => now,
  );
  caches.push(cache);
  const [first, joined] = await Promise.all([cache.get(TARGET), cache.get(TARGET)]);
  expect(joined).toEqual(first);
  expect(reads).toEqual([TARGET]);
  version = 2;
  now = 99;
  expect(await cache.get(TARGET)).toEqual(first);
  expect((await cache.get({ report: 'doctor', cwd: '/other' })).value).toEqual({ version: 2 });
  now = 100;
  expect((await cache.get(TARGET)).value).toEqual({ version: 2 });
  expect(reads).toEqual([TARGET, { report: 'doctor', cwd: '/other' }, TARGET]);
});

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
