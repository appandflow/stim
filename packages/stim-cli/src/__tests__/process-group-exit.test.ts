import * as os from 'node:os';
import { loadScaledBudgetMs } from '../process-group-exit.ts';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    loadavg: vi.fn<typeof original.loadavg>(original.loadavg),
    availableParallelism: vi.fn<typeof original.availableParallelism>(() => 10),
  };
});

test.each([
  { load: 0, budget: 5_000 },
  { load: 10, budget: 5_000 },
  { load: 30, budget: 15_000 },
  { load: 900, budget: 30_000 },
])('a load average of $load on 10 CPUs gives a $budget ms budget', ({ load, budget }) => {
  vi.mocked(os.loadavg).mockReturnValue([load, 0, 0]);
  expect(loadScaledBudgetMs(5_000, 30_000)).toBe(budget);
});
