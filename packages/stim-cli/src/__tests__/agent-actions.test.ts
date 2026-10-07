import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { workspaceAgentDeviceDir } from '../workspace/paths.ts';
import type { ProjectRecord } from '@stim-cli/core/state';
import type { ProcessStart } from '../process-identity.ts';
import { createAgentActionReader, workspaceAgentTargets, type AgentTarget } from '../devices/agent-actions.ts';

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

function claimStateDir(stateDir: string) {
  for (const name of ['ios', 'android']) {
    const file = join(root, 'device-claims', `${name}.json`);
    const claim = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...claim, stateDir }));
  }
}

beforeEach(() => {
  for (const name of ['AGENT_DEVICE_STATE_DIR', 'AGENT_DEVICE_CLAIMS_DIR', 'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR'])
    vi.stubEnv(name, '');
  home = mkdtempSync(join(tmpdir(), 'stim-agent-actions-'));
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  root = join(home, '.agent-device');
  cpSync(FIXTURE, root, { recursive: true });
  claimStateDir(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function read(targets: AgentTarget[], options: { sinceTs?: number; startOf?: typeof live } = {}) {
  return createAgentActionReader({ targets, home, startOf: options.startOf ?? live, ...options })();
}

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
    ts: Date.parse('2026-09-25T12:16:03.448Z'),
    startedAt: Date.parse('2026-09-25T12:15:57.453Z'),
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

describe('native macOS actions', () => {
  const target: AgentTarget = {
    platform: 'macos',
    id: 'owned-launch',
    slot: 'default',
    bundleId: 'dev.sample.stim.workspace',
    launchedAt: Date.parse('2026-09-25T12:15:00Z'),
  };
  const event = (seconds: number, command: string, details: object = {}, extra: object = {}) => ({
    version: 1,
    ts: new Date(target.launchedAt + seconds * 1000).toISOString(),
    session: 'native-proof',
    kind: 'action.recorded',
    command,
    summary: command,
    details,
    ...extra,
  });
  const open = (seconds: number, bundleId = target.bundleId, surface = 'app') =>
    event(seconds, 'open', { platform: 'macos', appBundleId: bundleId, flags: { surface } });
  const append = (...events: object[]) => {
    const dir = join(root, 'sessions', 'native-proof');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  test('matches the isolated app identifier, excludes previous launches, and preserves failures and duration', () => {
    append(
      open(-5),
      event(-1, 'press'),
      event(-1, 'type', {}, { kind: 'request.started', requestId: 'old-request' }),
      event(1, 'type', {}, { requestId: 'old-request' }),
      event(2, 'press', {}, { kind: 'request.started', requestId: 'press' }),
      event(4, 'press', { x: 20, y: 30 }, { requestId: 'press' }),
      event(5, 'scroll', {}, { kind: 'request.finished', status: 'error' }),
    );
    expect(read([target])).toEqual([
      expect.objectContaining({
        deviceId: 'owned-launch',
        platform: 'macos',
        command: 'press',
        details: { x: 20, y: 30 },
        startedAt: target.launchedAt + 2000,
        ts: target.launchedAt + 4000,
      }),
      expect.objectContaining({ event: 'agent_failed', level: 'error', command: 'scroll' }),
    ]);
    expect(read([{ ...target, bundleId: 'dev.sample.stim.other-workspace' }])).toEqual([]);
  });

  test('follows app switches across incremental reads and clears a closed or failed open', () => {
    append(open(0), event(1, 'press'));
    const reader = createAgentActionReader({ targets: [target], home });
    expect(reader().map((r) => r.command)).toEqual(['open', 'press']);
    append(open(2, 'dev.other'), event(3, 'type'));
    expect(reader()).toEqual([]);
    append(open(4), event(5, 'close'), event(6, 'press'));
    expect(reader().map((r) => r.command)).toEqual(['open', 'close']);
    append(open(7), event(8, 'open', {}, { kind: 'request.finished', status: 'error' }), event(9, 'press'));
    expect(reader().map((r) => r.command)).toEqual(['open']);
  });

  test('a follower started before the launch acquires the target, and a relaunch changes the launch ID', () => {
    let current: AgentTarget[] = [];
    const reader = createAgentActionReader({ targets: () => current, home });
    append(open(0), event(1, 'press'));
    expect(reader()).toEqual([]);
    current = [target];
    expect(reader().map((r) => [r.command, r.deviceId])).toEqual([
      ['open', 'owned-launch'],
      ['press', 'owned-launch'],
    ]);
    const relaunch = { ...target, id: 'second-launch', launchedAt: target.launchedAt + 10_000 };
    current = [relaunch];
    append(event(11, 'press'), open(12), event(13, 'type'));
    expect(reader().map((r) => [r.command, r.deviceId])).toEqual([
      ['press', 'second-launch'],
      ['open', 'second-launch'],
      ['type', 'second-launch'],
    ]);
  });

  test('an unrecorded open or close clears attribution before later actions', () => {
    append(open(0), event(1, 'press'));
    const reader = createAgentActionReader({ targets: [target], home });
    expect(reader()).toHaveLength(2);
    append(event(2, 'open', {}, { kind: 'request.started' }), event(3, 'press'));
    expect(reader()).toEqual([]);
    append(open(4), event(5, 'close', {}, { kind: 'request.started' }), event(6, 'type'));
    expect(reader().map((r) => r.command)).toEqual(['open']);
  });

  test('rotation cannot attribute actions after a missed app switch, even when the replacement is larger', () => {
    append(open(0), event(1, 'press'));
    const reader = createAgentActionReader({ targets: [target], home });
    expect(reader()).toHaveLength(2);
    append(open(2, 'dev.other'));
    const events = join(root, 'sessions', 'native-proof', 'events.ndjson');
    renameSync(events, `${events}.1`);
    append(...Array.from({ length: 20 }, (_, i) => event(i + 3, 'press')));
    expect(reader()).toEqual([]);
    append(open(25), event(26, 'type'));
    expect(reader().map((r) => r.command)).toEqual(['open', 'type']);
  });

  test('an unknown event version invalidates attribution until a fresh explicit app open', () => {
    append(open(0));
    const reader = createAgentActionReader({ targets: [target], home });
    expect(reader()).toHaveLength(1);
    append({ ...open(1, 'dev.other'), version: 2 }, event(2, 'press'));
    expect(reader()).toEqual([expect.objectContaining({ event: 'agent_format_unknown', platform: 'macos' })]);
    append(event(3, 'press'));
    expect(reader()).toEqual([]);
    append(open(4), event(5, 'press'));
    expect(reader().map((r) => r.command)).toEqual(['open', 'press']);
  });

  test('screenshots cannot inherit app attribution because their surface override is not recorded', () => {
    append(open(0), event(1, 'screenshot'), event(2, 'press'));
    expect(read([target]).map((r) => r.command)).toEqual(['open', 'press']);
  });

  test.each(['desktop', 'frontmost-app', 'menubar'])(
    'excludes the %s surface even with a matching app identifier',
    (surface) => {
      append(open(0, target.bundleId, surface), event(1, 'press'));
      expect(read([target])).toEqual([]);
    },
  );

  test('an open with an inherited surface cannot restore app attribution', () => {
    append(
      open(0, target.bundleId, 'menubar'),
      event(1, 'open', { platform: 'macos', appBundleId: target.bundleId }),
      event(2, 'press'),
    );
    expect(read([target])).toEqual([]);
  });
});

test('an Android session is attributed only while agent-device holds a live claim on the emulator', () => {
  const emulator: AgentTarget = { platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' };
  expect(read([emulator]).map((record) => [record.level, record.msg])).toEqual([
    ['error', 'Failed open: DEVICE_NOT_FOUND'],
    ['info', 'Opened io.tlon.groups'],
    ['info', 'Tapped (541, 2265)'],
  ]);
  expect(read([emulator], { startOf: gone })).toEqual([]);
  expect(read([{ ...emulator, name: 'stim-other' }])).toEqual([]);
});

test('later calls return only complete lines appended since the previous call, and a request keeps its start until it finishes', () => {
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
  const started = { ...JSON.parse(line), ts: '2026-09-25T12:17:01.000Z', kind: 'request.started', requestId: 'def' };
  appendFileSync(events, `${JSON.stringify(started)}\n`);
  expect(reader()).toEqual([]);
  appendFileSync(
    events,
    `${JSON.stringify({ ...JSON.parse(line), ts: '2026-09-25T12:17:04.000Z', requestId: 'def' })}\n`,
  );
  expect(reader()).toEqual([expect.objectContaining({ startedAt: Date.parse('2026-09-25T12:17:01.000Z') })]);
  expect(reader()).toEqual([]);
  appendFileSync(
    events,
    `${JSON.stringify({ ...JSON.parse(line), ts: '2026-09-25T12:17:05.000Z', requestId: 'def' })}\n`,
  );
  expect(reader()).toEqual([expect.objectContaining({ startedAt: Date.parse('2026-09-25T12:17:01.000Z') })]);
});

test('an action keeps its start time however many requests the session made before it', () => {
  const events = join(root, IOS_SESSION, 'events.ndjson');
  const entry = (at: number, kind: string, requestId: string, extra: object = {}) =>
    JSON.stringify({
      version: 1,
      ts: new Date(Date.parse('2026-09-25T12:17:00.000Z') + at).toISOString(),
      session: 'cwd:b764dacffe51e890:default',
      kind,
      requestId,
      command: 'press',
      summary: 'Tapped',
      ...extra,
    });
  const lines = Array.from({ length: 100 }, (_, i) => [
    entry(i * 1000, 'request.started', `r${i}`),
    entry(i * 1000 + 800, 'action.recorded', `r${i}`),
    entry(i * 1000 + 800, 'request.finished', `r${i}`, { status: 'ok' }),
  ]).flat();
  appendFileSync(events, `${lines.join('\n')}\n`);
  const tapped = read([{ platform: 'ios', id: SECOND_SIM, slot: 'default' }]).filter((r) => r.msg === 'Tapped');
  expect(tapped).toHaveLength(100);
  expect(tapped.every((record) => (record.ts as number) - (record.startedAt as number) === 800)).toBe(true);
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
    { platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' },
  ]);
});

test('workspace-only sessions are read through iOS runner logs and shared Android claims', () => {
  const stateDir = workspaceAgentDeviceDir('/projects/app');
  mkdirSync(stateDir, { recursive: true });
  renameSync(join(root, 'sessions'), join(stateDir, 'sessions'));
  claimStateDir(stateDir);
  const reader = createAgentActionReader({
    targets: [
      { platform: 'ios', id: FIRST_SIM, slot: 'default' },
      { platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' },
    ],
    home,
    startOf: live,
  });
  const records = reader();
  expect(records.filter((record) => record.platform === 'ios').map((record) => record.msg)).toEqual([
    'Opened com.appandflow.stim',
    'Ran snapshot',
    'Tapped @e7',
    'Closed default',
  ]);
  expect(records.filter((record) => record.platform === 'android').map((record) => record.msg)).toEqual([
    'Failed open: DEVICE_NOT_FOUND',
    'Opened io.tlon.groups',
    'Tapped (541, 2265)',
  ]);
  expect(reader()).toEqual([]);
  cpSync(join(stateDir, 'sessions', basename(IOS_SESSION)), join(root, IOS_SESSION), { recursive: true });
  expect(reader().map((record) => record.msg)).toEqual([
    'Opened com.appandflow.stim',
    'Ran snapshot',
    'Tapped @e7',
    'Closed default',
  ]);
});

test('a session name shared by two workspaces is attributed through the claim that names its state directory', () => {
  const other = workspaceAgentDeviceDir('/projects/other');
  mkdirSync(other, { recursive: true });
  cpSync(join(root, 'sessions'), join(other, 'sessions'), { recursive: true });
  const records = read([{ platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' }]);
  expect(records.map((record) => record.msg)).toEqual([
    'Failed open: DEVICE_NOT_FOUND',
    'Opened io.tlon.groups',
    'Tapped (541, 2265)',
  ]);
});
