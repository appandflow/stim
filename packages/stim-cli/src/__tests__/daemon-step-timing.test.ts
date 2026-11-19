import { dormantCandidates } from '../daemon/stages.ts';
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

test('a throw is recorded as threw with its message, and the same error object is rethrown', async () => {
  const failure = new Error('boom');

  await expect(timedStep(log, 'plan_rung6', () => Promise.reject(failure))).rejects.toBe(failure);

  expect(log.mock.calls[0]?.[3]).toMatchObject({ step: 'plan_rung6', outcome: 'threw', error: 'boom' });
});

test('a throw while the signal is aborted is recorded as aborted, without an error field', async () => {
  const controller = new AbortController();
  const failure = new Error('stopped');

  await expect(
    timedStep(
      log,
      'plan_worktrees',
      async () => {
        controller.abort();
        throw failure;
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(failure);

  expect(log.mock.calls[0]?.[3]).toMatchObject({ outcome: 'aborted' });
  expect(log.mock.calls[0]?.[3]).not.toHaveProperty('error');
});

test('a thrown value that cannot be described is still the value that is rethrown', async () => {
  const odd = {
    toString() {
      throw new Error('no string');
    },
  };

  await expect(timedStep(log, 'plan_history', () => Promise.reject(odd))).rejects.toBe(odd);

  expect(log.mock.calls[0]?.[3]).toMatchObject({ outcome: 'threw' });
});

test('through the shape every daemon log writer builds, the record keeps its severity and the pressure level', async () => {
  const written: Record<string, unknown>[] = [];
  const writer: DaemonLog = (level, event, msg, fields = {}) =>
    written.push({ src: 'stimd', level, event, msg, ...fields });

  await timedStep(writer, 'rung', async () => undefined, {
    fields: { rung: 5, pressureLevel: 'critical', level: 'critical', src: 'x', event: 'x', msg: 'x', ts: 1 },
  });

  expect(written).toEqual([
    expect.objectContaining({
      src: 'stimd',
      level: 'debug',
      event: 'daemon_step',
      step: 'rung',
      rung: 5,
      pressureLevel: 'critical',
      outcome: 'finished',
    }),
  ]);
  expect(written[0]).not.toHaveProperty('ts');
  expect(written[0]?.msg).toMatch(/^rung 5 finished in \d+ms$/);
});

test('an evidence loop returns what it returned without a log, and writes its record with one', async () => {
  const config = { version: 2 as const, projects: {}, repos: {} };
  const reading = { devices: [], simsFailed: false };

  const plain = await dormantCandidates(config, reading, 1000);
  const timed = await dormantCandidates(config, { ...reading, log }, 1000);

  expect(timed).toEqual(plain);
  expect(log.mock.calls[0]?.[3]).toMatchObject({ step: 'dormant_candidates', items: 0, outcome: 'finished' });
});

test('an error whose name cannot be read is still the error that is rethrown, recorded as threw', async () => {
  const odd = new Error('odd');
  Object.defineProperty(odd, 'name', {
    get() {
      throw new Error('no name');
    },
  });

  await expect(timedStep(log, 'plan_history', () => Promise.reject(odd))).rejects.toBe(odd);

  expect(log.mock.calls[0]?.[3]).toMatchObject({ outcome: 'threw' });
});

test('a step that has not ended is named every 10 minutes, and the records stop once it ends', async () => {
  let end!: () => void;
  const step = timedStep(log, 'collect_artifacts', () => new Promise<void>((resolve) => (end = resolve)), {
    fields: { rung: 5 },
  });

  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(log.mock.calls.map(([, event, , fields]) => [event, fields])).toEqual([
    ['daemon_step_running', expect.objectContaining({ step: 'collect_artifacts', rung: 5, runningMs: 600_000 })],
    ['daemon_step_running', expect.objectContaining({ step: 'collect_artifacts', rung: 5, runningMs: 1_200_000 })],
  ]);

  end();
  await step;
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(log.mock.calls.map(([, event]) => event)).toEqual([
    'daemon_step_running',
    'daemon_step_running',
    'daemon_step',
  ]);
});
