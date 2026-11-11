import { expect, test } from 'vitest';
import {
  createSlimDenialFilter,
  type LaunchdEvent,
  machServiceLabels,
  nextLogOffset,
  parseLaunchdLine,
} from '../stimd/logs/ios-slim.ts';

const SPAWN =
  '2026-11-10 22:45:35.756368 (user/501/UIKitApplication:com.example.app[dba4][rb-legacy] [59389]) <Notice>: xpcproxy_sim spawned with pid 59389';

test.each([
  [
    '2026-11-10 22:45:36.1 (user/501) <Warning>: failed lookup: name = com.apple.healthd.server, requestor = Health[59647], error = 3: No such process',
    {
      kind: 'lookup',
      service: 'com.apple.healthd.server',
      proc: 'Health',
      pid: 59647,
    },
  ],
  [
    '2026-11-10 22:45:35.7 (user/501) <Warning>: failed lookup: name = com.apple.chronoservices, flags = 0x200, requestor = WidgetRenderer_[57719], error = 3: No such process',
    {
      kind: 'lookup',
      service: 'com.apple.chronoservices',
      proc: 'WidgetRenderer_',
      pid: 57719,
    },
  ],
  [SPAWN, { kind: 'spawn', bundleId: 'com.example.app', pid: 59389 }],
  [
    '2026-11-10 22:45:36.1 (user/501) <Warning>: failed lookup: name = com.apple.x, requestor = App[1], error = 159: Sandbox restriction',
    null,
  ],
  [
    '2026-11-10 22:45:35.7 (user/501/UIKitApplication:com.example.app[dba4][rb-legacy] [59389]) <Notice>: Successfully spawned App[59389] because launch job demand',
    null,
  ],
])('parses %s', (line, expected) => {
  expect(parseLaunchdLine(line)).toEqual(expected);
});

test('maps Mach services by each plist Label, only for the labels asked for', () => {
  const map = machServiceLabels(
    [
      {
        Label: 'com.apple.textcontextd',
        MachServices: {
          'com.apple.textcontextd': true,
          'com.apple.tc.raw': true,
        },
      },
      {
        Label: 'com.apple.springboard',
        MachServices: { 'com.apple.springboard': true },
      },
      { Label: 'com.apple.healthd' },
      'not a plist',
    ],
    new Set(['com.apple.textcontextd', 'com.apple.healthd']),
  );
  expect([...map]).toEqual([
    ['com.apple.textcontextd', 'com.apple.textcontextd'],
    ['com.apple.tc.raw', 'com.apple.textcontextd'],
  ]);
});

function lookup(service: string, proc: string, pid: number): LaunchdEvent {
  return { kind: 'lookup', service, proc, pid };
}

test('reports the app process asking for a disabled service once per feature per launch', () => {
  const filter = createSlimDenialFilter({
    bundleId: 'com.example.app',
    executable: 'ExampleApplication',
    disabled: new Set(['com.apple.healthd', 'com.apple.itunesstored', 'com.apple.intelligencecontextd']),
    services: new Map([
      ['com.apple.healthd.server', 'com.apple.healthd'],
      ['com.apple.healthd.cache-delete', 'com.apple.healthd'],
      ['com.apple.itunesstored.xpc', 'com.apple.itunesstored'],
      ['com.apple.apsd', 'com.apple.apsd'],
      ['com.apple.uiintelligencesupport.agent', 'com.apple.intelligencecontextd'],
    ]),
  });

  expect(filter(lookup('com.apple.healthd.server', 'ExampleApplicat', 7))?.label).toBe('com.apple.healthd');
  expect(filter(lookup('com.apple.healthd.server', 'Health', 8))).toBeNull();
  expect(filter(lookup('com.apple.apsd', 'ExampleApplicat', 7))).toBeNull();
  expect(filter(lookup('com.apple.unknown', 'ExampleApplicat', 7))).toBeNull();

  expect(filter({ kind: 'spawn', bundleId: 'com.other', pid: 9 })).toBeNull();
  expect(filter(lookup('com.apple.healthd.server', 'Other', 9))).toBeNull();

  expect(filter({ kind: 'spawn', bundleId: 'com.example.app', pid: 10 })).toBeNull();
  expect(filter(lookup('com.apple.healthd.server', 'ExampleApplicat', 7))).toBeNull();
  const health = filter(lookup('com.apple.healthd.server', 'ExampleApplicat', 10));
  expect(health).toMatchObject({
    features: ['health'],
    slimCategory: 'health',
    pid: 10,
    level: 'warn',
  });
  expect(filter(lookup('com.apple.healthd.cache-delete', 'ExampleApplicat', 10))).toBeNull();
  expect(filter(lookup('com.apple.itunesstored.xpc', 'ExampleApplicat', 10))).toMatchObject({
    features: ['app-store', 'storekit'],
  });

  expect(filter(lookup('com.apple.uiintelligencesupport.agent', 'ExampleApplicat', 10))).toMatchObject({
    features: [],
    slimCategory: 'siri',
    level: 'debug',
  });

  expect(filter({ kind: 'spawn', bundleId: 'com.example.app', pid: 11 })).toBeNull();
  expect(filter(lookup('com.apple.healthd.server', 'ExampleApplicat', 11))).not.toBeNull();
});

test.each([
  ['the file grew', { ino: 5, size: 900 }, { offset: 400, restarted: false }],
  ['the file was truncated', { ino: 5, size: 100 }, { offset: 0, restarted: true }],
  ['the file was replaced by a rotation', { ino: 6, size: 900 }, { offset: 0, restarted: true }],
])('reads the log from the right place when %s', (_case, file, expected) => {
  expect(nextLogOffset({ ino: 5, offset: 400 }, file)).toEqual(expected);
});
