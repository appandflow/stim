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

import type { ProcessStart } from '../process-identity.ts';
import {
  createAsyncAgentActionReader as createAgentActionReader,
  createAsyncAgentActionReader,
  type AgentTarget,
} from '../devices/agent-actions.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'agent-device');
const IOS_SESSION = join('sessions', 'cwd_b764dacffe51e890_default');
const FIRST_SIM = '1F11A62B-F7CF-435D-BD1B-0FA926895E93';

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

  test('follows app switches across incremental reads and clears a closed or failed open', async () => {
    append(open(0), event(1, 'press'));
    const reader = createAgentActionReader({ targets: [target], home });
    expect((await reader()).map((r) => r.command)).toEqual(['open', 'press']);
    append(open(2, 'dev.other'), event(3, 'type'));
    expect(await reader()).toEqual([]);
    append(open(4), event(5, 'close', {}, { kind: 'request.started' }), event(5, 'close'), event(6, 'press'));
    expect((await reader()).map((r) => r.command)).toEqual(['open', 'close']);
    append(
      open(7),
      event(8, 'close', {}, { kind: 'request.started' }),
      event(8, 'close', {}, { kind: 'request.finished', status: 'error' }),
      event(9, 'press'),
    );
    expect((await reader()).map((r) => [r.command, r.level])).toEqual([
      ['open', 'info'],
      ['close', 'error'],
    ]);
  });

  test('an unknown event version invalidates attribution until a fresh explicit app open', async () => {
    append(open(0));
    const reader = createAgentActionReader({ targets: [target], home });
    expect(await reader()).toHaveLength(1);
    append({ ...open(1, 'dev.other'), version: 2 }, event(2, 'press'));
    expect(await reader()).toEqual([expect.objectContaining({ event: 'agent_format_unknown', platform: 'macos' })]);
    append(event(3, 'press'));
    expect(await reader()).toEqual([]);
    append(open(4), event(5, 'press'));
    expect((await reader()).map((r) => r.command)).toEqual(['open', 'press']);
  });
});

test('an Android session is attributed only while agent-device holds a live claim on the emulator', async () => {
  const emulator: AgentTarget = { platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' };
  expect((await read([emulator])).map((record) => [record.level, record.msg])).toEqual([
    ['error', 'Failed open: DEVICE_NOT_FOUND'],
    ['info', 'Opened io.tlon.groups'],
    ['info', 'Tapped (541, 2265)'],
  ]);
  expect(await read([emulator], { startOf: gone })).toEqual([]);
  expect(await read([{ ...emulator, name: 'stim-other' }])).toEqual([]);
});

test('workspace-only sessions are read through iOS runner logs and shared Android claims', async () => {
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
  const records = await reader();
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
  expect(await reader()).toEqual([]);
  cpSync(join(stateDir, 'sessions', basename(IOS_SESSION)), join(root, IOS_SESSION), { recursive: true });
  expect((await reader()).map((record) => record.msg)).toEqual([
    'Opened com.appandflow.stim',
    'Ran snapshot',
    'Tapped @e7',
    'Closed default',
  ]);
});

test('a session name shared by two workspaces is attributed through the claim that names its state directory', async () => {
  const other = workspaceAgentDeviceDir('/projects/other');
  mkdirSync(other, { recursive: true });
  cpSync(join(root, 'sessions'), join(other, 'sessions'), { recursive: true });
  const records = await read([{ platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' }]);
  expect(records.map((record) => record.msg)).toEqual([
    'Failed open: DEVICE_NOT_FOUND',
    'Opened io.tlon.groups',
    'Tapped (541, 2265)',
  ]);
});

test('async live-claim attribution preserves identity checks and yields across retained claims', async () => {
  const emulator: AgentTarget = { platform: 'android', id: 'emulator-5560', slot: 'default', name: 'stim-app' };
  const claim = readFileSync(join(root, 'device-claims', 'android.json'), 'utf8');
  for (let i = 0; i < 100; i++) writeFileSync(join(root, 'device-claims', `retained-${i}.json`), claim);
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const records = await createAsyncAgentActionReader({ targets: [emulator], home, startOf: live })();
  expect(yielded).toBe(true);
  expect(records).toEqual(await read([emulator]));
  expect(await createAsyncAgentActionReader({ targets: [emulator], home, startOf: gone })()).toEqual([]);
  const abort = new AbortController();
  const pending = createAsyncAgentActionReader({ targets: [emulator], home, startOf: live }, abort.signal)();
  setImmediate(() => abort.abort());
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
