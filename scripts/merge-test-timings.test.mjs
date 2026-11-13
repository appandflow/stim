import { compare, measure } from './merge-test-timings.mjs';

const at = (seconds) => new Date(seconds * 1000).toISOString();

function shard(index, duration, conclusion = 'success') {
  return {
    name: `merge tests (shard ${index}/2)`,
    conclusion,
    started_at: at(1),
    completed_at: at(duration + 31),
    steps: [{ name: 'Run Vitest shard', conclusion, started_at: at(30), completed_at: at(duration + 30) }],
  };
}

test('only complete two-shard runs contribute to the timing baseline', () => {
  expect(measure([shard(1, 300), shard(2, 280)])).toEqual({
    testSeconds: [300, 280],
    slowest: 300,
    runnerSeconds: 640,
  });
  expect(measure([shard(1, 300)])).toBeNull();
  expect(measure([shard(1, 300), shard(2, 280, 'cancelled')])).toBeNull();
});

test('flags a material jump without warning on small samples, ordinary noise or small absolute changes', () => {
  expect(compare(360, [300, 280, 430])).toEqual({ median: 300, change: 60, regression: true });
  expect(compare(359, [300, 280, 430])?.regression).toBe(false);
  expect(compare(460, [400, 400, 400])?.regression).toBe(false);
  expect(compare(140, [80, 90, 100])?.regression).toBe(false);
  expect(compare(500, [300, 300])).toBeNull();
});
