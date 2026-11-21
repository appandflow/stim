import type { DaemonLadderAction, DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import {
  acquireDisk,
  diskBoundary,
  joinablePass,
  LADDER,
  LANE,
  releaseDisk,
  requestGcPass,
  requestGcItem,
  type GcPassReply,
} from '../daemon/disk-owner.ts';
import { ladderRun } from '../stimd/passes/ladder-run.ts';
import type { LevelRun, LevelRunAction } from '../stimd/passes/level-run.ts';

const pressure: DaemonPressure = {
  level: 'high',
  disk: 'high',
  memory: 'normal',
  reasons: [],
  memoryWarningSince: null,
};

const action: LevelRunAction = {
  rung: null,
  kind: 'trim-cache',
  target: '/cache',
  outcome: 'done',
  bytes: 1,
  reason: 'over its cap',
  detail: '',
};

const runAt = (level: PressureLevel, actions: LevelRunAction[] = []): LevelRun => ({
  ...ladderRun(level, pressure, []),
  actions,
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, open };
}

/** A gc pass that records the level it ran at and finishes when `finish` opens. */
function heldPass(finish: Promise<void>, measured: PressureLevel = 'normal') {
  const runs: (PressureLevel | undefined)[] = [];
  const started = gate();
  const run = async (
    level: PressureLevel | undefined,
    signal: AbortSignal,
    onAction: (action: LevelRunAction) => void,
    onLevel: (level: PressureLevel) => void,
  ): Promise<Omit<GcPassReply, 'joined'>> => {
    runs.push(level);
    onLevel(level ?? measured);
    started.open();
    await Promise.race([
      finish,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ]);
    onAction(action);
    return { run: runAt(level ?? measured, [action]) };
  };
  return { runs, run, started: started.promise };
}

const ignore = () => {};

test('a gc with no level, the same level or a lower one joins the pass under way, which runs once', async () => {
  const finish = gate();
  const pass = heldPass(finish.promise);
  const first = requestGcPass('high', 'manual', pass.run, ignore);
  await pass.started;
  const seen: LevelRunAction[] = [];
  const joiners = [
    requestGcPass(undefined, 'desktop', pass.run, (landed) => seen.push(landed)),
    requestGcPass('high', 'desktop', pass.run, ignore),
    requestGcPass('normal', 'desktop', pass.run, ignore),
  ];
  finish.open();
  expect(await first.result).not.toHaveProperty('joined');
  for (const joiner of joiners)
    expect(await joiner.result).toMatchObject({
      joined: { trigger: 'manual', level: 'high', startedAt: expect.any(String) },
      run: { level: 'high', actions: [action] },
    });
  expect(pass.runs).toEqual(['high']);
  expect(seen).toEqual([action]);
});

test("a forced level joins the tick's disk pass at that level", async () => {
  const finish = gate();
  const ladder: DaemonLadderAction = {
    rung: 3,
    kind: 'trim-cargo',
    target: '/repo/target',
    outcome: 'done',
    bytes: 5,
    partial: true,
    detail: '',
  };
  const tick = joinablePass(
    'high',
    'pressure',
    () => finish.promise.then(() => ({ actions: [ladder], pressure })),
    (result) => ladderRun('high', result.pressure, result.actions),
  );
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const forced = requestGcPass('high', 'manual', unexpected, ignore);
  finish.open();
  await tick;
  expect(await forced.result).toMatchObject({
    joined: { trigger: 'pressure', level: 'high' },
    run: { level: 'high', actions: [{ rung: 3, kind: 'trim-cargo', target: '/repo/target', bytes: 5, partial: true }] },
  });
  expect(unexpected).not.toHaveBeenCalled();
});

test('a higher level queues one pass after the running one, and a still higher request raises it', async () => {
  const finish = gate();
  const pass = heldPass(finish.promise);
  const running = requestGcPass(undefined, 'manual', pass.run, ignore);
  await pass.started;
  const high = requestGcPass('high', 'manual', pass.run, ignore);
  const critical = requestGcPass('critical', 'desktop', pass.run, ignore);
  finish.open();
  expect(await running.result).toMatchObject({ run: { level: 'normal' } });
  expect(await high.result).not.toHaveProperty('joined');
  expect(await critical.result).toMatchObject({ joined: { trigger: 'manual', level: 'critical' } });
  expect(pass.runs).toEqual([undefined, 'critical']);
});

test.each([undefined, 'normal'] as const)(
  'withdrawing a queued critical request leaves the remaining %s request at its own level and rank',
  async (level) => {
    await acquireDisk(LANE);
    const pass = heldPass(Promise.resolve());
    const normal = requestGcPass(level, 'manual', pass.run, ignore);
    const critical = requestGcPass('critical', 'desktop', pass.run, ignore);
    critical.leave();
    await diskBoundary();
    await new Promise((done) => setImmediate(done));
    expect(pass.runs).toEqual([]);
    releaseDisk();
    await Promise.all([normal.result, critical.result]);
    expect(pass.runs).toEqual([level]);
  },
);

test('a request that leaves stops only a pass no other request waits for', async () => {
  const pass = heldPass(new Promise(() => {}));
  const alone = requestGcPass('high', 'manual', pass.run, ignore);
  await pass.started;
  alone.leave();
  const finish = gate();
  const next = heldPass(finish.promise);
  const rerun = requestGcPass(undefined, 'manual', next.run, ignore);
  await expect(alone.result).rejects.toThrow('aborted');
  finish.open();
  expect(await rerun.result).not.toHaveProperty('joined');
  expect(next.runs).toEqual([undefined]);

  const shared = heldPass(new Promise(() => {}));
  const first = requestGcPass('high', 'manual', shared.run, ignore);
  await shared.started;
  const second = requestGcPass('high', 'desktop', shared.run, ignore);
  const firstResult = first.result.catch((error: unknown) => error);
  first.leave();
  let settled = false;
  void second.result.catch(() => {}).finally(() => (settled = true));
  await new Promise((done) => setImmediate(done));
  expect(settled).toBe(false);
  second.leave();
  await expect(second.result).rejects.toThrow('aborted');
  expect(await firstResult).toMatchObject({ message: 'aborted' });
});

test("a gc pass takes the turn at the maintenance lane's next unit boundary", async () => {
  await acquireDisk(LANE);
  let ran = false;
  const asked = requestGcPass(
    'high',
    'manual',
    async () => {
      ran = true;
      return { run: runAt('high') };
    },
    ignore,
  );
  await new Promise((done) => setImmediate(done));
  expect(ran).toBe(false);
  await diskBoundary();
  expect(ran).toBe(true);
  await asked.result;
  releaseDisk();
});

test("a gc with no level or at normal joins the lane's acting maintenance pass and sees its actions; a higher one does not", async () => {
  const finish = gate();
  let emitted = (_action: LevelRunAction) => {};
  const unit = joinablePass(
    'normal',
    'maintenance',
    (emit) => {
      emitted = emit;
      return finish.promise;
    },
    () => runAt('normal', [action]),
    'lane',
  );
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const seen: LevelRunAction[] = [];
  const flagless = requestGcPass(undefined, 'manual', unexpected, (landed) => seen.push(landed));
  const normal = requestGcPass('normal', 'desktop', unexpected, ignore);
  const high = heldPass(Promise.resolve());
  const higher = requestGcPass('high', 'manual', high.run, ignore);
  emitted(action);
  finish.open();
  await unit;
  for (const joiner of [flagless, normal])
    expect(await joiner.result).toMatchObject({
      joined: { trigger: 'maintenance', level: 'normal' },
      run: { level: 'normal', actions: [action] },
    });
  expect(seen).toEqual([action]);
  expect(unexpected).not.toHaveBeenCalled();
  expect(await higher.result).not.toHaveProperty('joined');
  expect(high.runs).toEqual(['high']);
});

test("a gc at normal waits for the lane to end its run, and one above normal or raised above it takes the lane's next unit boundary", async () => {
  await acquireDisk(LANE);
  const order: string[] = [];
  const pass = (name: string) => async (level: PressureLevel | undefined) => {
    order.push(name);
    return { run: runAt(level ?? 'normal') };
  };
  const normal = requestGcPass('normal', 'manual', pass('normal'), ignore);
  await diskBoundary();
  await new Promise((done) => setImmediate(done));
  expect(order).toEqual([]);
  const raised = requestGcPass('critical', 'desktop', pass('raised'), ignore);
  await diskBoundary();
  expect(order).toEqual(['normal']);
  expect(await raised.result).toMatchObject({ run: { level: 'critical' } });
  expect(await normal.result).toMatchObject({ run: { level: 'critical' } });
  releaseDisk();
});

test('a request queued while the running pass had not measured joins it once that pass measures a level that covers it', async () => {
  const measure = gate();
  const finish = gate();
  const runs: (PressureLevel | undefined)[] = [];
  const run = async (
    level: PressureLevel | undefined,
    _signal: AbortSignal,
    _onAction: (action: LevelRunAction) => void,
    onLevel: (level: PressureLevel) => void,
  ) => {
    runs.push(level);
    if (runs.length === 1) {
      await measure.promise;
      onLevel('high');
      await finish.promise;
    }
    return { run: runAt(level ?? 'high', [action]) };
  };
  const first = requestGcPass(undefined, 'desktop', run, ignore);
  await new Promise((done) => setImmediate(done));
  const forced = requestGcPass('high', 'manual', run, ignore);
  measure.open();
  finish.open();
  expect(await first.result).not.toHaveProperty('joined');
  expect(await forced.result).toMatchObject({
    joined: { trigger: 'desktop', level: 'high' },
    run: { level: 'high', actions: [action] },
  });
  expect(runs).toEqual([undefined]);
});

test("a gc at normal that waits through the lane's dormant step joins the lane's maintenance pass once it starts", async () => {
  await acquireDisk(LANE);
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const seen: LevelRunAction[] = [];
  const waiting = requestGcPass(undefined, 'manual', unexpected, (landed) => seen.push(landed));
  await diskBoundary();
  await joinablePass(
    'normal',
    'maintenance',
    async (emit) => {
      await diskBoundary();
      emit(action);
    },
    () => runAt('normal', [action]),
    'lane',
  );
  releaseDisk();
  expect(await waiting.result).toMatchObject({
    joined: { trigger: 'maintenance', level: 'normal' },
    run: { actions: [action] },
  });
  expect(seen).toEqual([action]);
  expect(unexpected).not.toHaveBeenCalled();
});

test('pressure precedes each independent item at the lane boundary, then the lane resumes', async () => {
  await acquireDisk(LANE);
  const order: string[] = [];
  const first = requestGcItem(async () => {
    order.push('item');
    return 'first';
  });
  const second = requestGcItem(async () => {
    order.push('item');
    return 'second';
  });
  const high = requestGcPass(
    'high',
    'manual',
    async () => {
      order.push('pressure');
      return { run: runAt('high') };
    },
    ignore,
  );
  await diskBoundary();
  order.push('lane');
  releaseDisk();

  await high.result;
  expect(await first.result).toBe('first');
  expect(await second.result).toBe('second');
  expect(order).toEqual(['pressure', 'item', 'item', 'lane']);
});

test('cancelling a queued item settles while the holder keeps the turn and leaves the next item able to run', async () => {
  await acquireDisk(LANE);
  try {
    const work = vi.fn<() => Promise<void>>();
    const cancelled = requestGcItem(work);
    const next = requestGcItem(async () => 'next');
    cancelled.leave();
    await expect(cancelled.result).rejects.toBeInstanceOf(Error);
    expect(work).not.toHaveBeenCalled();
    await diskBoundary();
    expect(await next.result).toBe('next');
  } finally {
    releaseDisk();
  }
});

test('a cancelled headroom turn keeps the owner until its in-flight unit settles', async () => {
  const started = gate();
  const finish = gate();
  const first = requestGcItem(async () => {
    started.open();
    await finish.promise;
    return 'settled';
  }, LADDER);
  await started.promise;
  let nextStarted = false;
  const next = requestGcItem(async () => {
    nextStarted = true;
  });
  first.leave();
  await Promise.resolve();
  expect(nextStarted).toBe(false);
  finish.open();
  expect(await first.result).toBe('settled');
  await next.result;
  expect(nextStarted).toBe(true);
});
