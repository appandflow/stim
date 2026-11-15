import { timedStep, type DaemonLog } from '../daemon/step-timing.ts';

const log = vi.fn<DaemonLog>();

beforeEach(() => {
  log.mockReset();
});

test('the step returns what it returned and records the items it visited', async () => {
  const result = { rows: [1, 2, 3] };

  const returned = await timedStep(log, 'idle_stage_candidates', async (tally) => ((tally.items = 7), result));

  expect(returned).toBe(result);
  expect(log).toHaveBeenCalledWith(
    'debug',
    'daemon_step',
    expect.any(String),
    expect.objectContaining({ step: 'idle_stage_candidates', items: 7, outcome: 'finished' }),
  );
});

test('the step rethrows the error object it threw, with its properties, and a failing log does not replace it', async () => {
  const failure = Object.assign(new Error('unverified cleanup'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  log.mockImplementation(() => {
    throw new Error('log full');
  });

  await expect(
    timedStep<string[]>(log, 'plan_history', () => Promise.reject(failure), { items: (planned) => planned?.length }),
  ).rejects.toBe(failure);

  expect(log).toHaveBeenCalledTimes(1);
});

test('without a log the step only runs the function', async () => {
  await expect(timedStep(undefined, 'plan_rung6', async () => 'plan')).resolves.toBe('plan');
});
