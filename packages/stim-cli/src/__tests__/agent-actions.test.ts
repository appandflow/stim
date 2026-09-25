import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectRecord } from '@stim-cli/core/state';
import type { ProcessStart } from '../process-identity.ts';
import {
  createAgentActionReader,
  parseRunnerSpans,
  workspaceAgentTargets,
  type AgentTarget,
} from '../devices/agent-actions.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'agent-device');
const IOS_SESSION = join('sessions', 'cwd_b764dacffe51e890_default');
const FIRST_SIM = '1F11A62B-F7CF-435D-BD1B-0FA926895E93';
const SECOND_SIM = 'AD45387C-599D-4EDB-A62B-18176FF3A2A7';
const OWNER_START = 'Fri Sep 25 08:09:29 2026';

const live: (pid: number) => ProcessStart = (pid) =>
  pid === 15315 ? { status: 'running', startedAtMs: Date.parse(OWNER_START) } : { status: 'gone' };
const gone: (pid: number) => ProcessStart = () => ({ status: 'gone' });

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-agent-actions-'));
  root = join(home, '.agent-device');
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function read(targets: AgentTarget[], options: { sinceTs?: number; startOf?: typeof live } = {}) {
  return createAgentActionReader({ targets, home, startOf: options.startOf ?? live, ...options })();
}

test('a runner log that moves to another simulator yields one span per simulator', () => {
  const spans = parseRunnerSpans(readFileSync(join(root, IOS_SESSION, 'runner.log'), 'utf8'));
  expect(spans).toEqual([
    { deviceId: FIRST_SIM, from: -Infinity },
    { deviceId: SECOND_SIM, from: Date.parse('2026-09-25T12:16:01.015Z') },
  ]);
});

test('an iOS session is split between simulators at the close before the runner moved', () => {
  const second = read([{ platform: 'ios', id: SECOND_SIM, slot: 'phone' }]);
  expect(second.map((record) => [record.level, record.msg])).toEqual([
    ['info', 'Opened com.appandflow.stim'],
    ['info', 'Tapped (201, 542)'],
    ['error', 'Failed press: COMMAND_FAILED'],
    ['info', 'Captured screenshot home-light.png'],
  ]);
  expect(second[1]).toMatchObject({
    src: 'agent',
    slot: 'phone',
    event: 'agent_action',
    command: 'press',
    deviceId: SECOND_SIM,
    details: { x: 201, y: 542 },
  });
  expect(second[2]).toMatchObject({ event: 'agent_failed', command: 'press' });

  const first = read([{ platform: 'ios', id: FIRST_SIM, slot: 'default' }]);
  expect(first.map((record) => record.msg)).toEqual([
    'Opened com.appandflow.stim',
    'Ran snapshot',
    'Tapped @e7',
    'Closed default',
  ]);
  expect(first[0]).not.toHaveProperty('slot');
});

test('actions older than the workspace timeline are not merged', () => {
  const records = read([{ platform: 'ios', id: FIRST_SIM, slot: 'default' }], {
    sinceTs: Date.parse('2026-09-25T12:13:00Z'),
  });
  expect(records.map((record) => record.msg)).toEqual(['Closed default']);
});

test('an Android session is attributed only while agent-device holds a live claim on the emulator', () => {
  const emulator: AgentTarget = { platform: 'android', id: 'emulator-5560', slot: 'default' };
  expect(read([emulator]).map((record) => [record.level, record.msg])).toEqual([
    ['error', 'Failed open: DEVICE_NOT_FOUND'],
    ['info', 'Opened io.tlon.groups'],
    ['info', 'Tapped (541, 2265)'],
  ]);
  expect(read([emulator], { startOf: gone })).toEqual([]);
});

test('later calls return only complete lines appended since the previous call', () => {
  const reader = createAgentActionReader({
    targets: [{ platform: 'ios', id: SECOND_SIM, slot: 'default' }],
    home,
    startOf: live,
  });
  expect(reader()).toHaveLength(4);
  const events = join(root, IOS_SESSION, 'events.ndjson');
  const line = JSON.stringify({
    version: 1,
    ts: '2026-09-25T12:17:00.000Z',
    session: 'cwd:b764dacffe51e890:default',
    kind: 'action.recorded',
    requestId: 'abc',
    command: 'fill',
    summary: 'Filled @e3',
  });
  appendFileSync(events, line.slice(0, 40));
  expect(reader()).toEqual([]);
  appendFileSync(events, `${line.slice(40)}\n`);
  expect(reader().map((record) => record.msg)).toEqual(['Filled @e3']);
  expect(reader()).toEqual([]);
});

test('an unrecognized event format yields one warning instead of misread actions', () => {
  const events = join(root, IOS_SESSION, 'events.ndjson');
  writeFileSync(events, `${JSON.stringify({ version: 2, ts: '2026-09-25T12:17:00.000Z', type: 'tap', at: [1, 2] })}\n`);
  const records = read([{ platform: 'ios', id: SECOND_SIM, slot: 'default' }]);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ src: 'agent', level: 'warn', event: 'agent_format_unknown' });
});

test('targets are the workspace-owned simulators and emulators of every slot', () => {
  expect(
    workspaceAgentTargets({
      platforms: {
        ios: { owned: true, deviceUdid: FIRST_SIM },
        android: { owned: true, avdName: 'stim-app', consolePort: 5560 },
      },
      deviceSlots: { tablet: { ios: { owned: false, deviceUdid: SECOND_SIM } } },
    } as ProjectRecord),
  ).toEqual([
    { platform: 'ios', id: FIRST_SIM, slot: 'default' },
    { platform: 'android', id: 'emulator-5560', slot: 'default' },
  ]);
});
