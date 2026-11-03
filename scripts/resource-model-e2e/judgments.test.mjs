import { describe, expect, it } from 'vitest';
import { bucketRows, derivedDeviceCap, longestStreak, sampleQuality, secondsWhere } from './analysis.mjs';
import { createAssertions, judgeIdleTiming, outcome, STATUS } from './assertions.mjs';
import { bootsInFlight, idleFacts } from './evidence.mjs';
import { checkLadderOrder, diffState, ladderActions } from './ladder.mjs';
import { createBallast } from './ballast.mjs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIN = 60_000;

describe('derived device cap', () => {
  it('is 8 on a 16 GB machine and never below 2', () => {
    expect(derivedDeviceCap(16 * 1024 ** 3)).toBe(8);
    expect(derivedDeviceCap(8 * 1024 ** 3)).toBe(2);
  });
});

const rows = (levels) => levels.map((pressure, i) => ({ epoch: 1000 + i * 5, pressure }));

describe('longestStreak', () => {
  it('counts a run of k samples as (k - 1) intervals plus one', () => {
    expect(longestStreak(rows([1, ...Array(12).fill(4), 1]), (r) => r.pressure === 4, 5).ms).toBe(60_000);
    expect(longestStreak(rows([1, ...Array(13).fill(4), 1]), (r) => r.pressure === 4, 5).ms).toBe(65_000);
  });
  it('closes a run that reaches the last sample', () => {
    expect(longestStreak(rows([1, 4, 4]), (r) => r.pressure === 4, 5).samples).toBe(2);
  });
});

const at = (epoch, extra = {}) => ({ epoch, stage: 'batch', pressure: 1, load1: 100, ...extra });

describe('sampling that is not every 5 s', () => {
  it('counts a gap toward the state it follows and flags it', () => {
    const samples = [at(0, { pressure: 4 }), at(5, { pressure: 4 }), at(69, { pressure: 1 })];
    expect(longestStreak(samples, (r) => r.pressure === 4, 5).ms).toBe(69_000);
    expect(secondsWhere(samples, (r) => r.pressure === 4, 5)).toBe(69);
    expect(sampleQuality(samples, 5).gaps).toEqual([{ fromEpoch: 5, toEpoch: 69, sec: 64, stage: 'batch' }]);
  });

  it('flags a load reading that fell faster than a 1-minute average can, and not a steady decay', () => {
    const samples = [at(0, { load1: 1013 }), at(5, { load1: 6.9 }), at(10, { load1: 111 }), at(15, { load1: 105 })];
    expect(sampleQuality(samples, 5).suspectLoad).toEqual([{ epoch: 5, previous: 1013, reading: 6.9, sec: 5 }]);
  });

  it('reports the real spacing', () => {
    expect(sampleQuality([at(0), at(3), at(14), at(17)], 5)).toMatchObject({
      medianSec: 3,
      longestSec: 11,
      spanSec: 17,
    });
  });
});

describe('bucketRows', () => {
  it('keeps the extreme in the chosen direction', () => {
    const [bucket] = bucketRows(
      [
        { epoch: 0, a: 1, b: 9 },
        { epoch: 5, a: 7, b: 3 },
      ],
      60,
      { a: 'max', b: 'min' },
    );
    expect(bucket).toMatchObject({ a: 7, b: 3, samples: 2 });
  });
});

describe('idle timing judgment', () => {
  const base = { commandEndMs: 1_000_000, lastActivityMs: null, readAtMs: 1_000_000, windowMs: 15 * MIN, tickMs: MIN };
  it('passes when the previous working poll started before the deadline', () => {
    const verdict = judgeIdleTiming({
      ...base,
      previousPollStartMs: base.commandEndMs + 16 * MIN,
      idlePollStartMs: base.commandEndMs + 16 * MIN + 15_000,
      idlePollEndMs: base.commandEndMs + 16 * MIN + 17_000,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.deadline).toBe(base.commandEndMs + 16 * MIN);
  });
  it('fails when a poll that started after the deadline still saw the workspace working', () => {
    const verdict = judgeIdleTiming({
      ...base,
      previousPollStartMs: base.commandEndMs + 16 * MIN + 1,
      idlePollStartMs: base.commandEndMs + 17 * MIN,
      idlePollEndMs: base.commandEndMs + 17 * MIN + 2000,
    });
    expect(verdict.ok).toBe(false);
  });
  it('fails a workspace that went idle before its last command plus the window minus one tick', () => {
    const idleAt = base.commandEndMs + 2 * MIN;
    const verdict = judgeIdleTiming({
      ...base,
      previousPollStartMs: null,
      idlePollStartMs: idleAt - 2000,
      idlePollEndMs: idleAt,
    });
    expect(verdict).toMatchObject({ ok: false, early: true, earliest: base.commandEndMs + 14 * MIN });
  });
  describe('dormancy with a quiet daemon', () => {
    const window = 20 * MIN;
    const judge = (afterMs, previousAfterMs = null) =>
      judgeIdleTiming({
        ...base,
        windowMs: window,
        tickMs: MIN,
        lateTickMs: 5 * MIN,
        previousPollStartMs: previousAfterMs === null ? null : base.commandEndMs + previousAfterMs,
        idlePollStartMs: base.commandEndMs + afterMs - 2000,
        idlePollEndMs: base.commandEndMs + afterMs,
      });
    it('allows up to the window plus the quiet tick, and no more', () => {
      expect(judge(24.5 * MIN, 24 * MIN).ok).toBe(true);
      expect(judge(26.5 * MIN, 25.5 * MIN).ok).toBe(false);
    });
    it('does not let the quiet tick move the earliest time: a delete on the 15 minute idle clock fails', () => {
      expect(judge(15.3 * MIN)).toMatchObject({ ok: false, early: true, earliest: base.commandEndMs + 19 * MIN });
      expect(judge(19.2 * MIN).ok).toBe(true);
    });
  });
  describe('an idle stop before the window ends', () => {
    const idleAt = base.commandEndMs + 3 * MIN;
    const judge = (pressureLevel, when = idleAt) =>
      judgeIdleTiming({
        ...base,
        previousPollStartMs: null,
        idlePollStartMs: when - 2000,
        idlePollEndMs: when,
        pressureLevel,
      });
    it('passes only when the build reported high or critical pressure and the workspace had been idle two minutes', () => {
      expect(judge('high')).toMatchObject({ ok: true, early: true, earlyAllowed: true });
      expect(judge('critical').ok).toBe(true);
    });
    it('fails with a normal level, no level, or too short an idle', () => {
      expect(judge('normal').ok).toBe(false);
      expect(judge(null).ok).toBe(false);
      expect(judge('high', base.commandEndMs + 1 * MIN).ok).toBe(false);
    });
  });
  describe('an idle stop the daemon recorded under pressure', () => {
    const pollAt = base.commandEndMs + 13 * MIN;
    const judge = (daemonIdle, pressureLevel = 'normal') =>
      judgeIdleTiming({
        ...base,
        previousPollStartMs: null,
        idlePollStartMs: pollAt - 2000,
        idlePollEndMs: pollAt,
        pressureLevel,
        daemonIdle,
      });
    it('passes although no status poll reported high, when the record names high or critical and 2 minutes of idle', () => {
      const verdict = judge({ atMs: base.commandEndMs + 12 * MIN, pressure: 'high' });
      expect(verdict).toMatchObject({ ok: true, early: true, earlyAllowed: true });
      expect(verdict.evidence.join('\n')).toContain("allowed: the daemon's log records the idle at");
      expect(judge({ atMs: base.commandEndMs + 12 * MIN, pressure: 'critical' }).ok).toBe(true);
    });
    it('fails a record at normal pressure even when a status poll reported high', () => {
      expect(judge({ atMs: base.commandEndMs + 12 * MIN, pressure: null }, 'high').ok).toBe(false);
    });
    it('fails a pressure record under 2 minutes of idle, judged at the record time rather than the poll time', () => {
      expect(judge({ atMs: base.commandEndMs + 1 * MIN, pressure: 'high' }).ok).toBe(false);
    });
    it('judges earliness by the record time: a normal idle the poll saw only after the earliest time still fails', () => {
      const verdict = judgeIdleTiming({
        ...base,
        previousPollStartMs: null,
        idlePollStartMs: base.commandEndMs + 14 * MIN + 1000,
        idlePollEndMs: base.commandEndMs + 14 * MIN + 3000,
        daemonIdle: { atMs: base.commandEndMs + 13 * MIN, pressure: null },
      });
      expect(verdict).toMatchObject({ ok: false, early: true });
    });
  });
  it('treats status activity, which is rounded down to the minute, as up to a minute later', () => {
    const verdict = judgeIdleTiming({
      ...base,
      lastActivityMs: base.commandEndMs + 5 * MIN,
      readAtMs: base.commandEndMs + 10 * MIN,
      previousPollStartMs: null,
      idlePollStartMs: 0,
      idlePollEndMs: 0,
    });
    expect(verdict.deadline).toBe(base.commandEndMs + 6 * MIN + 16 * MIN);
  });
});

describe('assertion aggregation', () => {
  it('fails on any failed item, passes on checked items, and is unavailable when nothing could be checked', () => {
    const A = createAssertions();
    A.fromItems('s', 'a', 't', [outcome('w1', STATUS.pass, 'ok'), outcome('w2', STATUS.fail, 'bad')]);
    A.fromItems('s', 'b', 't', [outcome('w1', STATUS.pass, 'ok'), outcome('w2', STATUS.unavailable, 'no')]);
    A.fromItems('s', 'c', 't', [outcome('w1', STATUS.unavailable, 'no')]);
    expect(A.list.map((a) => a.status)).toEqual(['fail', 'pass', 'unavailable']);
    expect(A.list[0].evidence).toEqual(['w1: ok', 'w2: bad']);
  });
});

describe('idle facts from status', () => {
  const stopped = {
    stage: { kind: 'stopped' },
    metro: { running: false, idleStop: { reason: 'idle', at: 'x', idleMinutes: 1 } },
    ios: { udid: 'U', state: 'Shutdown', idleShutdown: { at: 'x', idleMinutes: 1 } },
  };
  it("recognises a main-build idle stop from Metro's record and the device state", () => {
    expect(idleFacts(stopped)).toMatchObject({ idle: true, stageIdle: false, idleShutdowns: 1 });
  });
  it('does not call a workspace idle while its simulator is booted', () => {
    expect(idleFacts({ ...stopped, ios: { udid: 'U', state: 'Booted' } }).idle).toBe(false);
  });
  it('takes the idle stage from the idleStage record the daemon writes', () => {
    const facts = idleFacts({
      stage: { kind: 'stopped' },
      idleStage: { at: 'x', idleMinutes: 15, freedBytes: 42 },
      metro: { running: false },
      ios: { udid: 'U', state: 'Shutdown' },
    });
    expect(facts).toMatchObject({ idle: true, stageIdle: true });
  });
  it('takes the dormant stage from the dormantStage record and ignores stage.kind values of idle or dormant', () => {
    const dormant = {
      stage: { kind: 'stopped' },
      dormantStage: { at: 'x', dormantDays: 3, deletedDevices: [], archived: [] },
    };
    expect(idleFacts({ ...dormant, metro: { running: false }, ios: null })).toMatchObject({ stageIdle: true });
    expect(
      idleFacts({ stage: { kind: 'idle' }, metro: { running: true }, ios: { udid: 'U', state: 'Booted' } }),
    ).toMatchObject({
      idle: false,
      stageIdle: false,
    });
  });
  it('reports boots in flight only where the capacity section lists holders', () => {
    expect(bootsInFlight({ capacity: {} })).toBeNull();
    expect(bootsInFlight({ capacity: { devices: { holders: [{ booting: true }, {}] } } })).toBe(1);
  });
});

describe('ladder state changes', () => {
  const ws = { metroUp: true, devicesUp: 1, deviceExists: true, derived: true, nodeModules: true, pods: true };
  it('names what each transition freed', () => {
    const next = { ...ws, metroUp: false, devicesUp: 0, derived: false, deviceExists: false, pods: false };
    const kinds = diffState(
      { workspaces: { a: ws }, caches: { 'build-cache': 100 } },
      { workspaces: { a: next }, caches: { 'build-cache': 50 } },
      5,
    ).map((e) => e.kind);
    expect(kinds).toEqual([
      'idle-stop',
      'idle-stop',
      'derived-data-delete',
      'device-delete',
      'deps-delete',
      'cache-trim',
    ]);
  });
});

const line = (record) => JSON.stringify(record);
const A04 = '/h/work/r-04';
const A05 = '/h/work/r-05';
const action = (ts, rung, kind, target, extra = {}) =>
  line({ event: 'pressure_action', rung, kind, target, outcome: 'done', bytes: 0, ts, ...extra });
const idle = (ts, workspace) => line({ event: 'workspace_idle', workspace, freedBytes: 5, ts });
const tick = (ts) => line({ event: 'daemon_tick', ts });

describe('pressure level of an idle record', () => {
  const idleMsg = (why) =>
    line({
      event: 'workspace_idle',
      workspace: A04,
      msg: `${A04}: no activity for 11 minutes (${why}; last: native run): Stopped: supervisor pid 1 stopped`,
      freedBytes: 0,
      ts: 5000,
    });
  const levelOf = (why) => ladderActions({ daemonText: idleMsg(why) }).actions[0].pressure;
  it('reads high and critical from the pressure form of the message and null from the idle clock form', () => {
    expect(levelOf('pressure level high: macOS memory pressure has been warning for 10 minutes')).toBe('high');
    expect(levelOf('pressure level critical: macOS memory pressure is critical')).toBe('critical');
    expect(levelOf('idle.minutes is 15')).toBe(null);
  });
});

describe('ladder order from the daemon log', () => {
  const run = [
    idle(1000, A04),
    idle(1900, A05),
    tick(2000),
    action(200_000, 4, 'dormant-stage', A04, { workspace: A04 }),
    tick(200_100),
    action(500_000, 3, 'empty-cache', '/h/compilation-cache', { bytes: 2_969_333_760 }),
    action(500_100, 3, 'empty-cache', '/h/build-cache', { outcome: 'kept' }),
    action(560_000, 4, 'dormant-stage', A05, { workspace: A05 }),
    action(570_000, 5, 'delete-dependencies', `${A04}/node_modules`, { workspace: A04, bytes: 1_180_147_712 }),
    tick(580_000),
  ].join('\n');

  it('passes a correct ladder even though rung 3 first acts after rung 4 had acted in an earlier tick', () => {
    const ladder = ladderActions({ daemonText: run });
    const verdict = checkLadderOrder(ladder);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.rungs).toEqual([1, 3, 4, 5]);
    expect(verdict.evidence.some((e) => e.includes('rung 4 dormant-stage r-04'))).toBe(true);
  });

  it('ignores actions that kept something and takes the device deletion time from the daemon', () => {
    const { actions } = ladderActions({ daemonText: run });
    expect(actions.filter((a) => a.kind === 'empty-cache')).toHaveLength(1);
    expect(actions.find((a) => a.kind === 'dormant-stage' && a.workspace === A04).ts).toBe(200_000);
  });

  it('counts an action once when the workspace log keeps a copy of it', () => {
    const copy = action(200_001, 4, 'dormant-stage', A04);
    const { actions } = ladderActions({ daemonText: run, workspaceLogs: [{ workspace: A04, text: copy }] });
    expect(actions.filter((a) => a.kind === 'dormant-stage' && a.target === A04)).toHaveLength(1);
  });

  it('fails when a tick goes back to an earlier rung', () => {
    const text = [
      action(10, 5, 'delete-dependencies', A04, { workspace: A04 }),
      action(20, 3, 'empty-cache', '/h/cc'),
      tick(30),
    ].join('\n');
    expect(checkLadderOrder(ladderActions({ daemonText: text })).verdict).toBe('fail');
  });

  it('skips the within-tick rule, and says so, when the log has no tick records', () => {
    const text = [
      idle(1000, A04),
      action(2000, 4, 'dormant-stage', A04, { workspace: A04 }),
      action(3000, 3, 'empty-cache', '/h/cc'),
    ].join('\n');
    const verdict = checkLadderOrder(ladderActions({ daemonText: text }));
    expect(verdict.verdict).toBe('pass');
    expect(verdict.evidence.some((e) => e.includes('no tick records'))).toBe(true);
  });

  it('leaves out the workspaces the scenario starts and stops again', () => {
    const text = [
      action(10, 4, 'dormant-stage', A04, { workspace: A04 }),
      tick(15),
      idle(20_000, A04),
      tick(20_100),
      idle(30_000, A05),
      tick(30_100),
    ].join('\n');
    expect(checkLadderOrder(ladderActions({ daemonText: text })).verdict).toBe('fail');
    expect(checkLadderOrder(ladderActions({ daemonText: text }), { skipWorkspaces: [A04] }).verdict).toBe('pass');
  });

  it('fails when a workspace is idled after it went dormant, and has no verdict with one rung', () => {
    const text = [
      action(10, 4, 'dormant-stage', A04, { workspace: A04 }),
      tick(15),
      idle(20_000, A04),
      tick(20_100),
    ].join('\n');
    expect(checkLadderOrder(ladderActions({ daemonText: text })).verdict).toBe('fail');
    expect(checkLadderOrder(ladderActions({ daemonText: [idle(1, A04), tick(2)].join('\n') })).verdict).toBe(
      'unavailable',
    );
    expect(checkLadderOrder(ladderActions({ daemonText: '' })).verdict).toBe('unavailable');
  });
});

describe('ballast', () => {
  it('writes real bytes until the volume has the requested free space, and never past the floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ballast-'));
    try {
      const state = { ballast: null };
      const start = 100 * 1024 ** 2;
      const ballast = createBallast({
        dir,
        free: () => start - (state.ballast?.bytes ?? 0),
        chunkBytes: 8 * 1024 ** 2,
        floorBytes: 10 * 1024 ** 2,
      });
      state.ballast = ballast;
      const stepped = await ballast.stepTo(40 * 1024 ** 2);
      expect(stepped.after).toBeLessThanOrEqual(40 * 1024 ** 2);
      expect(statSync(ballast.file).size).toBe(ballast.bytes);
      const clamped = await ballast.stepTo(1024);
      expect(clamped.clamped).toBe(true);
      expect(clamped.after).toBeGreaterThanOrEqual(10 * 1024 ** 2 - 8 * 1024 ** 2);
      await ballast.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
