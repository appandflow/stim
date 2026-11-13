import { resumeDecision } from '../stimd/logs/streams.ts';

const root = '/work/app';
const spec = { root, platform: 'ios', slot: 'default', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
const handedOver = { kind: 'stream', streamId: 's1', handover: true, handedOverAt: '2026-11-10T12:00:00.000Z', spec };
const crashed = { kind: 'stream', streamId: 's1', startedAt: '2026-11-10T12:00:00.000Z', spec };
const stop = (reason: 'requested' | 'idle', at: string) =>
  reason === 'idle' ? { reason, at, idleMinutes: 15 } : { reason, at, by: 'stim stop', byPid: 1 };

test.each([
  { why: 'a stream with no stop since its handover', record: handedOver, stopped: null, reason: null },
  {
    why: 'a stream whose workspace was stopped before its handover',
    record: handedOver,
    stopped: stop('requested', '2026-11-10T11:59:00.000Z'),
    reason: null,
  },
  {
    why: 'a stream whose workspace was stopped after its handover',
    record: handedOver,
    stopped: stop('requested', '2026-11-10T12:00:01.000Z'),
    reason: 'the workspace stopped after the handover',
    lost: false,
  },
  {
    why: 'a stream whose dev server went idle after its handover',
    record: handedOver,
    stopped: stop('idle', '2026-11-10T12:00:01.000Z'),
    reason: 'the workspace stopped after the handover',
    lost: false,
  },
  {
    why: 'a stream with no readable handover time and any recorded stop',
    record: { ...handedOver, handedOverAt: 'soon' },
    stopped: stop('requested', '2000-01-01T00:00:00.000Z'),
    reason: 'the workspace stopped after the handover',
    lost: false,
  },
  {
    why: 'a stream whose stimd died, with a stop recorded before the stream started',
    record: crashed,
    stopped: stop('requested', '2026-11-10T11:00:00.000Z'),
    reason: null,
  },
  {
    why: 'a stream whose stimd died, with a stop recorded after the stream started',
    record: crashed,
    stopped: stop('requested', '2026-11-10T12:00:01.000Z'),
    reason: 'the workspace stopped after the handover',
    lost: false,
  },
  {
    why: 'a record without a spec',
    record: { ...handedOver, spec: undefined },
    stopped: null,
    reason: 'its record holds no stream spec',
    lost: true,
  },
  {
    why: 'a physical iPhone console',
    record: { ...handedOver, spec: { ...spec, physical: true } },
    stopped: null,
    reason: 'a physical device console is not resumed',
    lost: true,
  },
  {
    why: 'a spec naming another workspace',
    record: { ...handedOver, spec: { ...spec, root: '/work/other' } },
    stopped: null,
    reason: 'its spec names another workspace, /work/other',
    lost: false,
  },
  {
    why: 'a spec naming another slot',
    record: { ...handedOver, spec: { ...spec, slot: 'phone' } },
    stopped: null,
    reason: 'its spec names another slot',
    lost: false,
  },
])('a successor decides on $why', ({ record, stopped, reason, lost }) => {
  const decision = resumeDecision(record, root, 'ios', stopped);
  expect(decision).toEqual(reason === null ? { spec } : { reason, lost });
});
