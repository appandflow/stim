import { timelineMarkers } from '../src/replay.ts';

test('markers are the agent actions on this device and errors of the workspace, oldest first', () => {
  const records = [
    { ts: 900, src: 'agent', event: 'agent_action', platform: 'ios', command: 'press', msg: 'too early' },
    {
      ts: 3200,
      startedAt: 1200,
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      command: 'press',
      msg: 'press @e3',
    },
    {
      ts: 1250,
      src: 'agent',
      level: 'error',
      event: 'agent_failed',
      platform: 'ios',
      command: 'fill',
      msg: 'Failed fill',
    },
    { ts: 1100, src: 'agent', event: 'agent_action', platform: 'web', command: 'click', msg: 'other device' },
    { ts: 1300, src: 'agent', event: 'agent_action', platform: 'ios', slot: 'tablet', msg: 'other slot' },
    { ts: 1400, src: 'metro', level: 'error', msg: 'Unable to resolve module\n  at line 3' },
    { ts: 1500, src: 'device', level: 'fatal', platform: 'ios', event: 'native_crash', msg: 'crashed' },
    { ts: 1600, src: 'device', level: 'error', platform: 'android', msg: 'android only' },
    { ts: 1700, src: 'client', level: 'warn', msg: 'a warning' },
  ];
  expect(timelineMarkers(records, 'ios', 'default', 1000)).toEqual([
    { at: 1200, kind: 'action', command: 'press', label: 'press @e3' },
    { at: 1250, kind: 'action', command: 'fill', label: 'Failed fill' },
    { at: 1400, kind: 'error', label: 'Unable to resolve module' },
    { at: 1500, kind: 'crash', label: 'crashed' },
  ]);
});

test("an agent action lands where its session's measured screen puts it", () => {
  const records = [
    {
      ts: 1100,
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      command: 'press',
      session: 'measured',
      msg: 'Tapped',
      details: { x: 201, y: 437 },
    },
    {
      ts: 1200,
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      command: 'scroll',
      session: 'measured',
      msg: 'Scrolled',
      details: { x1: 201, y1: 600, x2: 201, y2: 200, durationMs: 300 },
    },
    {
      ts: 1300,
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      command: 'press',
      session: 'unmeasured',
      msg: 'Tapped',
      details: { x: 10, y: 10 },
    },
  ];
  const viewport = (session: string) => (session === 'measured' ? { width: 402, height: 874 } : null);
  expect(timelineMarkers(records, 'ios', 'default', 1000, viewport)).toEqual([
    { at: 1100, kind: 'action', command: 'press', label: 'Tapped', x: 0.5, y: 0.5 },
    { at: 1200, kind: 'action', command: 'scroll', label: 'Scrolled', x: 0.5, y: 600 / 874, x2: 0.5, y2: 200 / 874 },
    { at: 1300, kind: 'action', command: 'press', label: 'Tapped' },
  ]);
});
