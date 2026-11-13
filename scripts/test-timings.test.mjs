import { compare, measure } from './test-timings.mjs';

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
  expect(measure([shard(1, 300), shard(2, 280)], 'merge')).toEqual({
    testSeconds: [300, 280],
    duration: 300,
    runnerSeconds: 640,
  });
  expect(measure([shard(1, 300)], 'merge')).toBeNull();
  expect(measure([shard(1, 300), shard(2, 280, 'cancelled')], 'merge')).toBeNull();
});

test('a main push measures completed test steps while its Node 24 job is still running', () => {
  const unit = { name: 'Unit tests (vitest)', conclusion: 'success', started_at: at(10), completed_at: at(130) };
  const integration = {
    name: 'Integration tests (vitest)',
    conclusion: 'success',
    started_at: at(150),
    completed_at: at(650),
  };
  const main = { name: 'test (node 24)', status: 'in_progress', steps: [unit, integration] };
  expect(measure([main], 'main', true)?.duration).toBe(620);
  expect(measure([main], 'main')).toBeNull();
  expect(measure([{ ...main, steps: [unit] }], 'main', true)).toBeNull();
});

test('flags a material jump without warning on small samples, ordinary noise or small absolute changes', () => {
  expect(compare(360, [300, 280, 430])).toEqual({ median: 300, change: 60, regression: true });
  expect(compare(359, [300, 280, 430])?.regression).toBe(false);
  expect(compare(460, [400, 400, 400])?.regression).toBe(false);
  expect(compare(140, [80, 90, 100])?.regression).toBe(false);
  expect(compare(500, [300, 300])).toBeNull();
});
