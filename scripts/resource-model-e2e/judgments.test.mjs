import { describe, expect, it } from 'vitest';
import { bucketRows, derivedDeviceCap, longestStreak } from './analysis.mjs';
import { createAssertions, judgeIdleTiming, outcome, STATUS } from './assertions.mjs';
import { bootsInFlight, idleFacts } from './evidence.mjs';
import { checkRungOrder, diffState } from './ladder.mjs';
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
  it('takes an idle stage from the build when it reports one', () => {
    expect(
      idleFacts({ stage: { kind: 'idle' }, metro: { running: true }, ios: { udid: 'U', state: 'Booted' } }).idle,
    ).toBe(true);
  });
  it('reports boots in flight only where the capacity section lists holders', () => {
    expect(bootsInFlight({ capacity: {} })).toBeNull();
    expect(bootsInFlight({ capacity: { devices: { holders: [{ booting: true }, {}] } } })).toBe(1);
  });
});

describe('ladder order', () => {
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
  it('fails when a later rung freed state before an earlier one', () => {
    const events = [
      { at: 1000, rung: 4, kind: 'device-delete', workspace: 'a' },
      { at: 50_000, rung: 1, kind: 'idle-stop', workspace: 'b' },
    ];
    expect(checkRungOrder(events, 15_000).verdict).toBe('fail');
  });
  it('is no verdict with a single rung', () => {
    expect(checkRungOrder([{ at: 1, rung: 1, kind: 'idle-stop', workspace: 'a' }], 15_000).verdict).toBe('unavailable');
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
