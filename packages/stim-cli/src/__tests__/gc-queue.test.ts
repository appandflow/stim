import type { DaemonLadderAction, DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import {
  acquireDisk,
  diskBoundary,
  joinablePass,
  LANE,
  releaseDisk,
  requestGcPass,
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
    detail: '',
  };
  const tick = joinablePass(
    'high',
    'pressure',
    finish.promise.then(() => ({ actions: [ladder], pressure })),
    (result) => ladderRun('high', result.pressure, result.actions),
  );
  const unexpected = vi.fn<Parameters<typeof requestGcPass>[2]>();
  const forced = requestGcPass('high', 'manual', unexpected, ignore);
  finish.open();
  await tick;
  expect(await forced.result).toMatchObject({
    joined: { trigger: 'pressure', level: 'high' },
    run: { level: 'high', actions: [{ rung: 3, kind: 'trim-cargo', target: '/repo/target', bytes: 5 }] },
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

test('a request that leaves stops only a pass no other request waits for', async () => {
  const pass = heldPass(new Promise(() => {}));
  const alone = requestGcPass('high', 'manual', pass.run, ignore);
  await pass.started;
  alone.leave();
  await expect(alone.result).rejects.toThrow('aborted');

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
