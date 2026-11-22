import type { DaemonLadderAction, DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import {
  acquireDisk,
  CRITICAL,
  HARD_FLOOR,
  type DiskTurn,
  joinablePass,
  LADDER,
  LANE,
  TRASH,
  reportDiskQueue,
  requestGcPass,
  requestGcItem,
  type GcPassReply,
} from '../daemon/disk-owner.ts';
import * as reserve from '../disk-reserve.ts';
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
  const turn = await acquireDisk(LADDER);
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
  turn.release();
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
    const turn = await acquireDisk(LANE);
    const pass = heldPass(Promise.resolve());
    const normal = requestGcPass(level, 'manual', pass.run, ignore);
    const critical = requestGcPass('critical', 'desktop', pass.run, ignore);
    critical.leave();
    await turn.boundary();
    await new Promise((done) => setImmediate(done));
    expect(pass.runs).toEqual([]);
    turn.release();
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
  const turn = await acquireDisk(LANE);
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
  await turn.boundary();
  expect(ran).toBe(true);
  await asked.result;
  turn.release();
});

test("a gc with no level or at normal joins the lane's acting maintenance pass and sees its actions; a higher one does not", async () => {
  const finish = gate();
  let emitted = (_action: LevelRunAction) => {};
  const turn = await acquireDisk(LANE);
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
  turn.release();
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
  const turn = await acquireDisk(LANE);
  const order: string[] = [];
  const pass = (name: string) => async (level: PressureLevel | undefined) => {
    order.push(name);
    return { run: runAt(level ?? 'normal') };
  };
  const normal = requestGcPass('normal', 'manual', pass('normal'), ignore);
  await turn.boundary();
  await new Promise((done) => setImmediate(done));
  expect(order).toEqual([]);
  const raised = requestGcPass('critical', 'desktop', pass('raised'), ignore);
  await turn.boundary();
  expect(order).toEqual(['normal']);
  expect(await raised.result).toMatchObject({ run: { level: 'critical' } });
  expect(await normal.result).toMatchObject({ run: { level: 'critical' } });
  turn.release();
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
  const turn = await acquireDisk(LANE);
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const seen: LevelRunAction[] = [];
  const waiting = requestGcPass(undefined, 'manual', unexpected, (landed) => seen.push(landed));
  await turn.boundary();
  await joinablePass(
    'normal',
    'maintenance',
    async (emit) => {
      await turn.boundary();
      emit(action);
    },
    () => runAt('normal', [action]),
    'lane',
  );
  turn.release();
  expect(await waiting.result).toMatchObject({
    joined: { trigger: 'maintenance', level: 'normal' },
    run: { actions: [action] },
  });
  expect(seen).toEqual([action]);
  expect(unexpected).not.toHaveBeenCalled();
});

test('pressure precedes independent items, then trash drains before the lane resumes', async () => {
  const turn = await acquireDisk(LANE);
  const order: string[] = [];
  const first = requestGcItem(async () => {
    order.push('item');
    return 'first';
  });
  const second = requestGcItem(async () => {
    order.push('item');
    return 'second';
  });
  const trash = requestGcItem(async () => {
    order.push('trash');
  }, TRASH);
  const high = requestGcPass(
    'high',
    'manual',
    async () => {
      order.push('pressure');
      return { run: runAt('high') };
    },
    ignore,
  );
  await turn.boundary();
  order.push('lane');
  turn.release();

  await high.result;
  expect(await first.result).toBe('first');
  expect(await second.result).toBe('second');
  await trash.result;
  expect(order).toEqual(['pressure', 'item', 'item', 'trash', 'lane']);
});

test.each([false, true])(
  'a trash boundary yields between entries without releasing a pressure turn when cancelled=%s',
  async (cancel) => {
    const entered = gate();
    const nextEntry = gate();
    const pressureEntered = gate();
    const pressureDone = gate();
    const order: string[] = [];
    const trash = requestGcItem(async (signal, turn) => {
      order.push('first entry');
      entered.open();
      await nextEntry.promise;
      await turn.boundary();
      signal.throwIfAborted();
      order.push('second entry');
    }, TRASH);
    await entered.promise;
    const high = requestGcItem(async () => {
      order.push('pressure');
      pressureEntered.open();
      await pressureDone.promise;
    }, LADDER);
    nextEntry.open();
    await pressureEntered.promise;
    if (cancel) trash.leave();
    const item = requestGcItem(async () => {
      order.push('item');
    });
    await Promise.resolve();
    expect(order).toEqual(['first entry', 'pressure']);
    pressureDone.open();
    const settled = await Promise.allSettled([trash.result, high.result, item.result]);
    expect(settled[0]?.status).toBe(cancel ? 'rejected' : 'fulfilled');
    expect(order).toEqual(['first entry', 'pressure', 'item', ...(cancel ? [] : ['second entry'])]);
  },
);

test('cancelling a queued item settles while the holder keeps the turn and leaves the next item able to run', async () => {
  const turn = await acquireDisk(LANE);
  try {
    const work = vi.fn<() => Promise<void>>();
    const cancelled = requestGcItem(work);
    const next = requestGcItem(async () => 'next');
    cancelled.leave();
    await expect(cancelled.result).rejects.toBeInstanceOf(Error);
    expect(work).not.toHaveBeenCalled();
    await turn.boundary();
    expect(await next.result).toBe('next');
  } finally {
    turn.release();
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

test('a queued critical successor preempts high at a settled unit, then high and lane resume with their own results', async () => {
  const states: unknown[] = [];
  reportDiskQueue((state) => states.push(state));
  const owner = await acquireDisk(LANE);
  const ready = gate();
  const first = gate();
  const criticalDone = gate();
  const second = gate();
  const highStarted = gate();
  const criticalStarted = gate();
  const highResumed = gate();
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const unit = async (name: string, finish: Promise<void>) => {
    active++;
    maximum = Math.max(maximum, active);
    order.push(name);
    try {
      await finish;
    } finally {
      active--;
    }
  };
  const nextAction = { ...action, target: '/second' };
  const laneResult = joinablePass(
    'normal',
    'maintenance',
    async (emit) => {
      await ready.promise;
      await owner.boundary();
      await unit('lane', Promise.resolve());
      emit(action);
    },
    () => runAt('normal', [action]),
    'lane',
  );
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const normal = requestGcPass(undefined, 'desktop', unexpected, ignore);
  let highOwner: DiskTurn | undefined;
  const high = requestGcPass(
    'high',
    'manual',
    async (_level, signal, emit, found, turn) => {
      highOwner = turn;
      found('high');
      highStarted.open();
      await unit('high first', first.promise);
      emit(action);
      await turn.boundary();
      signal.throwIfAborted();
      highResumed.open();
      await unit('high second', second.promise);
      emit(nextAction);
      return { run: runAt('high', [action, nextAction]) };
    },
    ignore,
  );
  ready.open();
  await highStarted.promise;
  const seen: LevelRunAction[] = [];
  const joined = requestGcPass('high', 'desktop', unexpected, (entry) => seen.push(entry));
  const critical = requestGcPass(
    'critical',
    'desktop',
    async (_level, _signal, _emit, found) => {
      found('critical');
      criticalStarted.open();
      await unit('critical', criticalDone.promise);
      return { run: runAt('critical') };
    },
    ignore,
  );
  try {
    expect(order).toEqual(['high first']);
    first.open();
    await criticalStarted.promise;
    expect(order).toEqual(['high first', 'critical']);
    expect(states.at(-1)).toMatchObject({ running: { trigger: 'desktop' }, queued: 2 });
    criticalDone.open();
    await critical.result;
    await highResumed.promise;
    expect(states.at(-1)).toMatchObject({ running: { trigger: 'manual' }, queued: 1 });
    const resumed = requestGcPass('high', 'desktop', unexpected, ignore);
    second.open();
    const initialJoin = await joined.result;
    const resumedJoin = await resumed.result;
    expect(resumedJoin.joined).toEqual(initialJoin.joined);
    expect(resumedJoin.run.actions).toEqual([action, nextAction]);
    await high.result;
    await laneResult;
    expect(await normal.result).toMatchObject({ joined: { trigger: 'maintenance', level: 'normal' } });
    expect(seen).toEqual([action, nextAction]);
    expect(order).toEqual(['high first', 'critical', 'high second', 'lane']);
    expect(maximum).toBe(1);
    expect(unexpected).not.toHaveBeenCalled();
  } finally {
    first.open();
    criticalDone.open();
    second.open();
    ready.open();
    highOwner?.release();
    owner.release();
    reportDiskQueue(() => {});
    await Promise.allSettled([high.result, critical.result, laneResult, normal.result, joined.result]);
  }
});

test.each([
  [LADDER, CRITICAL],
  [CRITICAL, HARD_FLOOR],
])('a rank %s boundary yields only to higher rank %s and resumes behind waiting peers', async (rank, higherRank) => {
  const owner = await acquireDisk(rank);
  const order: string[] = [];
  const equal = requestGcItem(async () => {
    order.push('equal');
  }, rank);
  const lower = requestGcItem(async () => {
    order.push('lower');
  }, LANE);
  await owner.boundary();
  expect(order).toEqual([]);
  const higher = requestGcItem(async () => {
    order.push('critical');
  }, higherRank);
  await owner.boundary();
  order.push('resumed');
  owner.release();
  await Promise.all([equal.result, lower.result, higher.result]);
  expect(order).toEqual(['critical', 'equal', 'resumed', 'lower']);
});

test('cancelling a suspended pass leaves the critical owner intact and runs no next unit', async () => {
  const first = gate();
  const started = gate();
  const criticalStarted = gate();
  const finishCritical = gate();
  const units: string[] = [];
  const high = requestGcPass(
    'high',
    'manual',
    async (_level, signal, _emit, found, turn) => {
      found('high');
      started.open();
      units.push('first');
      await first.promise;
      await turn.boundary();
      signal.throwIfAborted();
      units.push('second');
      return { run: runAt('high') };
    },
    ignore,
  );
  await started.promise;
  const critical = requestGcPass(
    'critical',
    'manual',
    async () => {
      criticalStarted.open();
      await finishCritical.promise;
      return { run: runAt('critical') };
    },
    ignore,
  );
  first.open();
  await criticalStarted.promise;
  high.leave();
  let ended = false;
  const outcome = high.result.catch((error: unknown) => {
    ended = true;
    return error;
  });
  await Promise.resolve();
  expect(ended).toBe(false);
  const after = requestGcItem(async () => {
    units.push('item');
  });
  expect(units).toEqual(['first']);
  finishCritical.open();
  await critical.result;
  await expect(outcome).resolves.toBeInstanceOf(Error);
  await after.result;
  expect(units).toEqual(['first', 'item']);
});

test('a lane finishing its post-delete reads does not recreate reserve during another disk turn', async () => {
  const owner = await acquireDisk(LANE);
  const finish = gate();
  const run = joinablePass(
    'normal',
    'maintenance',
    () => finish.promise,
    () => runAt('normal'),
    'lane',
  );
  owner.release();
  const other = await acquireDisk(CRITICAL);
  const keep = vi.spyOn(reserve, 'keepReserve').mockImplementation(() => {});
  try {
    finish.open();
    await run;
    expect(keep).not.toHaveBeenCalled();
  } finally {
    finish.open();
    other.release();
    keep.mockRestore();
  }
});

test('a pass measured above normal keeps that rank when an item waits at its next boundary', async () => {
  const started = gate();
  const resume = gate();
  const order: string[] = [];
  const pass = requestGcPass(
    undefined,
    'manual',
    async (_level, _signal, _emit, found, turn) => {
      found('high');
      started.open();
      await resume.promise;
      await turn.boundary();
      order.push('pass');
      return { run: runAt('high') };
    },
    ignore,
  );
  await started.promise;
  const item = requestGcItem(async () => {
    order.push('item');
  });
  resume.open();
  await Promise.all([pass.result, item.result]);
  expect(order).toEqual(['pass', 'item']);
});

test('a last queued gc requester leaves without taking another owner or starting a pass', async () => {
  const owner = await acquireDisk(LADDER);
  const work = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const cancelled = requestGcPass('critical', 'manual', work, ignore);
  let ended = false;
  const outcome = cancelled.result.catch((error: unknown) => {
    ended = true;
    return error;
  });
  const itemWork = vi.fn<() => Promise<void>>(async () => {});
  const item = requestGcItem(itemWork);
  cancelled.leave();
  try {
    await vi.waitFor(() => expect(ended).toBe(true));
    await expect(outcome).resolves.toBeInstanceOf(Error);
    await owner.boundary();
    expect(work).not.toHaveBeenCalled();
    expect(itemWork).not.toHaveBeenCalled();
  } finally {
    owner.release();
    await Promise.all([outcome, item.result]);
  }
});

test('queue status reports the active owner, waiting units and an idle queue', async () => {
  const states: unknown[] = [];
  reportDiskQueue((status) => states.push(status));
  const turn = await acquireDisk(LANE);
  const item = requestGcItem(async () => 'removed');
  expect(states.at(-1)).toMatchObject({ running: { trigger: 'maintenance' }, queued: 1 });
  await turn.boundary();
  await item.result;
  expect(states).toContainEqual({ running: { trigger: 'item', startedAt: expect.any(String) }, queued: 1 });
  turn.release();
  expect(states.at(-1)).toEqual({ running: null, queued: 0 });
  reportDiskQueue(() => {});
});
