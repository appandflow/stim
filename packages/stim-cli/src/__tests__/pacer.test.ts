import { createDiskPacer } from '../daemon/pacer.ts';

const minute = 60_000;
const read = (device: number, freeMb: number, level: 'normal' | 'high' | 'critical' = 'normal') => ({
  device,
  freeMb,
  level,
});

function advance(pacer: ReturnType<typeof createDiskPacer>, readings: ReturnType<typeof read>[]) {
  vi.advanceTimersByTime(minute);
  return pacer.observe(readings, Date.now());
}

test('3 GiB per minute starts before measured pressure rises and targets one tick of headroom', () => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 8 * 1024)], Date.now());
  expect(pacer.targets(1024, minute)).toEqual([]);
  advance(pacer, [read(1, 5 * 1024)]);
  expect(pacer.targets(1024, minute)).toEqual([]);
  advance(pacer, [read(1, 2 * 1024)]);
  expect(pacer.targets(1024, minute)).toEqual([
    { device: 1, fillMbPerMs: (3 * 1024) / minute, leadTimeMs: minute, freeMb: 4 * 1024 },
  ]);
});

test.each([0, 1024])('flat or recovering free space never predicts cleanup: change=$0', (change) => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 1500)], Date.now());
  const rates = advance(pacer, [read(1, 1500 + change)]);
  expect(rates).toEqual([{ device: 1, fillMbPerMs: 0 }]);
  expect(pacer.targets(1024, minute)).toEqual([]);
});

test('learned lead uses the positive measurement time and the actual next tick interval', () => {
  const pacer = createDiskPacer();
  const at = Date.now();
  pacer.observe([read(1, 10_000)], at);
  advance(pacer, [read(1, 9_000)]);
  expect(pacer.targets(1024, 5 * minute)).toEqual([]);
  advance(pacer, [read(1, 8_000)]);
  pacer.recordFirstFree(1, at, Date.now());
  expect(pacer.targets(1024, 5 * minute)).toEqual([
    { device: 1, fillMbPerMs: 1000 / minute, leadTimeMs: 7 * minute, freeMb: 8024 },
  ]);
});

test('the stop target is exclusive for admission, and disabled thresholds admit nothing', () => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 3000)], Date.now());
  advance(pacer, [read(1, 2000)]);
  expect(pacer.targets(1000, minute)).toEqual([]);
  expect(pacer.targets(1001, minute)).toEqual([
    { device: 1, fillMbPerMs: 1000 / minute, leadTimeMs: minute, freeMb: 2001 },
  ]);
  expect(pacer.targets(0, minute)).toEqual([]);
});

test('device histories and learned lead are isolated, measured high and critical remain outside the pacer', () => {
  const pacer = createDiskPacer();
  const at = Date.now();
  pacer.observe([read(1, 3000), read(2, 3000), read(3, 3000), read(4, 3000)], at);
  advance(pacer, [read(1, 2000), read(2, 3000), read(3, 2000, 'high'), read(4, 2000, 'critical')]);
  pacer.recordFirstFree(1, at, at + minute);
  expect(pacer.targets(1000, minute).map(({ device }) => device)).toEqual([1]);
});

test('unknown and disappearing devices supply no history or learned latency', () => {
  const pacer = createDiskPacer();
  const at = Date.now();
  expect(pacer.observe([{ freeMb: 1000, level: 'normal' }], at)).toEqual([]);
  pacer.observe([read(1, 3000)], at);
  advance(pacer, [read(1, 2000)]);
  pacer.recordFirstFree(1, at, at + 10 * minute);
  pacer.observe([], Date.now());
  pacer.observe([read(1, 2000)], Date.now());
  expect(pacer.targets(1000, minute)).toEqual([]);
  advance(pacer, [read(1, 1500)]);
  expect(pacer.targets(1000, minute)).toEqual([]);
});

test('bursty observations coalesce per minute and old fill evidence expires after five minutes', () => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 10_000)], Date.now());
  advance(pacer, [read(1, 2000)]);
  for (let i = 0; i < 10_000; i++) pacer.observe([read(1, 2000)], Date.now());
  expect(pacer.targets(1000, minute)).toHaveLength(1);
  for (let i = 0; i < 6; i++) advance(pacer, [read(1, 2000)]);
  expect(pacer.targets(1000, minute)).toEqual([]);
});

test('a quiet five-minute tick with ordinary delay retains the window boundary measurement', () => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 20_000)], Date.now());
  vi.advanceTimersByTime(5 * minute + 2000);
  expect(pacer.observe([read(1, 5_000)], Date.now())[0]?.fillMbPerMs).toBeCloseTo(15_000 / (5 * minute + 2000));
  expect(pacer.targets(1024, 5 * minute)).toHaveLength(1);
});

test('an admitted predictive episode survives repeated attempts but rate observations alone start none', () => {
  const pacer = createDiskPacer();
  pacer.observe([read(1, 5000)], Date.now());
  advance(pacer, [read(1, 4000)]);
  expect(pacer.status()[0]?.predictive).toBeUndefined();
  const since = Date.now();
  pacer.recordPredictive(1, 4000, 6000, since);
  vi.advanceTimersByTime(61 * minute);
  pacer.recordPredictive(1, 3000, 7000, Date.now());
  expect(pacer.status()[0]?.predictive).toEqual({
    since,
    targetFreeMb: 6000,
    lastAttemptAt: Date.now(),
    checkedAt: Date.now(),
    freeMb: 3000,
  });
  pacer.observe([read(1, 6000)], Date.now());
  expect(pacer.status()[0]?.predictive).toBeUndefined();
});

test.each(['rate recovers', 'measured high', 'disabled', 'prediction ends', 'cancelled'] as const)(
  'predictive evidence ends when %s',
  (change) => {
    const pacer = createDiskPacer();
    pacer.observe([read(1, 5000)], Date.now());
    advance(pacer, [read(1, 4000)]);
    pacer.recordPredictive(1, 4000, 6000, Date.now());
    if (change === 'rate recovers') advance(pacer, [read(1, 5500)]);
    else if (change === 'measured high') pacer.observe([read(1, 3000, 'high')], Date.now());
    else if (change === 'disabled') pacer.targets(0, minute);
    else if (change === 'prediction ends') pacer.targets(1, 1);
    else pacer.endPredictive(1);
    expect(pacer.status()[0]?.predictive).toBeUndefined();
  },
);

test.each([58_000, 63_000])('a short burst cannot authorize cleanup across a shifted minute: %d', (offset) => {
  const pacer = createDiskPacer();
  const at = Math.floor(Date.now() / minute) * minute + offset;
  pacer.observe([read(1, 60 * 1024)], at);
  pacer.observe([read(1, 58 * 1024)], at + 4000);
  expect(pacer.targets(40 * 1024, minute)).toEqual([]);
});
