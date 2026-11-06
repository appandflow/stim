import * as fc from 'fast-check';
import {
  decideIdleStop,
  idleKeep,
  idleScope,
  PRESSURE_IDLE_MS,
  type IdleKeepFacts,
  type IdleStopEvidence,
} from '../policy/idle.ts';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const MINUTE_MS = 60_000;
const SETTING = 'idle.minutes';

const activity: fc.Arbitrary<IdleStopEvidence['activity'][number]> = fc.record({
  basis: fc.constantFrom('stim command', 'native run', 'Metro request', 'agent-device command'),
  at: fc.oneof(
    fc.integer({ min: 0, max: 360 }).map((minutes) => NOW - minutes * MINUTE_MS),
    fc.constantFrom(NaN, -Infinity),
  ),
});

describe('the idle stop decision', () => {
  test('a workspace is stopped only when every activity source is older than its threshold and nothing keeps it', () => {
    fc.assert(
      fc.property(
        fc.array(activity, { maxLength: 6 }),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
        fc.integer({ min: 1, max: 240 }).map((minutes) => minutes * MINUTE_MS),
        (sources, keep, idleMs) => {
          const decision = decideIdleStop({ activity: sources, keep }, { idleMs, now: NOW, setting: SETTING });
          const known = sources.filter(({ at }) => Number.isFinite(at));
          const lastAt = Math.max(...known.map(({ at }) => at));
          const recent = known.some(({ at }) => NOW - at < idleMs);
          const stops = known.length > 0 && !recent && keep.length === 0;
          expect(decision.stop ? [decision.idleMs, decision.last.at] : null).toEqual(
            stops ? [NOW - lastAt, lastAt] : null,
          );
          expect(!decision.stop && decision.active === true).toBe(recent);
        },
      ),
    );
  });

  test('a threshold of 0 never stops, whatever the activity', () => {
    fc.assert(
      fc.property(fc.array(activity, { maxLength: 4 }), fc.integer({ min: -MINUTE_MS, max: 0 }), (sources, idleMs) => {
        expect(decideIdleStop({ activity: sources, keep: [] }, { idleMs, now: NOW, setting: SETTING })).toEqual({
          stop: false,
          reason: `${SETTING} is 0`,
        });
      }),
    );
  });
});

const scopeFacts = fc.record({
  protected: fc.boolean(),
  serving: fc.boolean(),
  unsupervised: fc.boolean(),
  simsError: fc.option(fc.constant('simctl failed')),
  booted: fc.array(fc.record({ deferred: fc.boolean() }), { maxLength: 3 }),
  foreign: fc.array(fc.constantFrom('Pixel', 'iPhone'), { maxLength: 2 }),
});

describe('the activity pass scope', () => {
  test('the protected workspace is never taken, whatever else runs', () => {
    fc.assert(
      fc.property(scopeFacts, (facts) => {
        expect(idleScope({ ...facts, protected: true })).toEqual({ runs: false });
      }),
    );
  });

  test('a workspace with nothing running, or only devices a deferred shutdown holds, is left out', () => {
    const idle = { protected: false, serving: false, unsupervised: false, simsError: null, foreign: [] };
    expect(idleScope({ ...idle, booted: [] })).toEqual({ runs: false });
    expect(idleScope({ ...idle, booted: [{ deferred: true }, { deferred: true }] })).toEqual({ runs: false });
    expect(idleScope({ ...idle, booted: [{ deferred: true }, { deferred: false }] })).toBeNull();
    expect(idleScope({ ...idle, booted: [], foreign: ['Pixel'] })).toMatchObject({ runs: true, kept: /Pixel/ });
  });
});

const keepFacts: fc.Arbitrary<IdleKeepFacts> = fc.record({
  settings: fc.oneof(
    fc.record({ keep: fc.boolean(), minutes: fc.integer({ min: 0, max: 240 }) }),
    fc.record({ error: fc.constant('bad .stim.json') }),
  ),
  supervisor: fc.record({ status: fc.constantFrom('ours', 'unverified', 'stale', 'none') }),
  command: fc.boolean(),
  hmrUpdates: fc.boolean(),
  orphan: fc.option(fc.constant('its dev server (pid 9) may still run')),
  hosted: fc.record({
    placements: fc.array(fc.record({ label: fc.constant('iOS simulator'), machine: fc.constant('mini') }), {
      maxLength: 1,
    }),
    unreadable: fc.array(fc.constant('hosted ios record is unreadable'), { maxLength: 1 }),
  }),
  pressured: fc.boolean(),
});

describe('what keeps a running workspace', () => {
  test('any keep reason wins over the threshold', () => {
    fc.assert(
      fc.property(keepFacts, (facts) => {
        const { settings, supervisor, hosted } = facts;
        const keeps =
          'error' in settings ||
          settings.keep ||
          settings.minutes === 0 ||
          supervisor.status === 'unverified' ||
          facts.orphan !== null ||
          (supervisor.status === 'ours' && (facts.command || !facts.hmrUpdates)) ||
          hosted.placements.length + hosted.unreadable.length > 0;
        expect('kept' in idleKeep(facts)).toBe(keeps);
      }),
    );
  });

  test('pressure shortens the threshold to PRESSURE_IDLE_MS and never lengthens it', () => {
    const running = { supervisor: { status: 'none' }, command: false, hmrUpdates: true, orphan: null };
    const hosted = { placements: [], unreadable: [] };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 240 }), (minutes) => {
        const settings = { keep: false, minutes };
        expect(idleKeep({ ...running, settings, hosted, pressured: false })).toEqual({
          idleMs: minutes * MINUTE_MS,
          minutes,
        });
        const pressured = Math.min(minutes * MINUTE_MS, PRESSURE_IDLE_MS);
        expect(idleKeep({ ...running, settings, hosted, pressured: true })).toEqual({
          idleMs: pressured,
          minutes: Math.ceil(pressured / MINUTE_MS),
        });
      }),
    );
  });
});
