import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceAgentDeviceDir } from '../workspace/paths.ts';
import {
  closeOwnedDeviceSessions,
  isOwnDeviceSession,
  parseAgentDeviceSessions,
} from '../devices/agent-device-cleanup.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const ios = {
  name: 'ios-task',
  platform: 'ios',
  device: 'stim-app (iPhone 17 26.0)',
  device_udid: 'U1',
  id: 'U1',
  createdAt: 1789292795715,
};
const android = {
  name: 'android-task',
  platform: 'android',
  device: 'stim-app fold',
  id: 'emulator-5554',
  createdAt: 1789292795716,
};
const payload = (sessions: unknown[]) => JSON.stringify({ success: true, data: { sessions } });

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
});

test('parses live CLI records without treating malformed or cross-platform identities as targets', () => {
  expect(
    parseAgentDeviceSessions(
      payload([
        ios,
        android,
        null,
        { ...ios, platform: 'macos' },
        { ...ios, id: 'OTHER' },
        { ...ios, createdAt: undefined },
        { ...ios, name: '' },
        { ...ios, device_udid: undefined },
        { ...android, name: 'default', address: 'cwd:a504:android' },
      ]),
    ),
  ).toEqual([
    { name: ios.name, platform: 'ios', id: 'U1', device: ios.device, createdAt: ios.createdAt },
    android,
    { ...android, name: 'cwd:a504:android' },
  ]);
  for (const output of ['oops', '{}', '{"success":false,"data":{"sessions":[]}}']) {
    expect(() => parseAgentDeviceSessions(output)).toThrow(/JSON|successful session list/);
  }
});

test('with an owner, closes only a session its claim on that device places inside that workspace', () => {
  const device = { platform: 'ios' as const, id: 'U1' };
  const session = ios;
  const owner = (claims: { session: string | null; workspace: string | null; deviceId?: string }[]) => ({
    workspace: '/w/app',
    claims: claims.map((claim) => ({ deviceId: 'U1', ...claim })),
  });
  expect(isOwnDeviceSession(session, device, owner([{ session: 'ios-task', workspace: '/w/app' }]))).toBe(true);
  expect(isOwnDeviceSession(session, device, owner([{ session: 'ios-task', workspace: '/w/app/src' }]))).toBe(true);
  expect(isOwnDeviceSession(session, device, owner([]))).toBe(false);
  expect(isOwnDeviceSession(session, device, owner([{ session: 'other', workspace: '/w/app' }]))).toBe(false);
  expect(isOwnDeviceSession(session, device, owner([{ session: 'ios-task', workspace: '/w/app-2' }]))).toBe(false);
  expect(isOwnDeviceSession(session, device, owner([{ session: 'ios-task', workspace: null }]))).toBe(false);
  expect(
    isOwnDeviceSession(session, device, owner([{ session: 'ios-task', workspace: '/w/app', deviceId: 'U2' }])),
  ).toBe(false);
  const fromRoot = (workspace: string) => ({
    ...owner([{ session: 'ios-task', workspace }]),
    workspace: '/w/repo/app',
    repoRoot: '/w/repo',
  });
  expect(isOwnDeviceSession(session, device, fromRoot('/w/repo'))).toBe(true);
  expect(isOwnDeviceSession(session, device, fromRoot('/w/repo/other'))).toBe(false);
  expect(isOwnDeviceSession(session, device, fromRoot('/w'))).toBe(false);
});

test('closes claimed workspace sessions with --state-dir even when the default inventory fails', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-agent-cleanup-')));
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', join(home, 'claims'));
  const workspace = join(home, 'app');
  mkdirSync(workspace);
  const stateDir = workspaceAgentDeviceDir(workspace);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'daemon.json'), '{}');
  mkdirSync(join(home, 'claims'));
  writeFileSync(
    join(home, 'claims', 'claim.json'),
    JSON.stringify({
      session: ios.name,
      workspace,
      device: { id: 'U1' },
    }),
  );
  const calls: string[][] = [];
  setExecutor({
    findExecutable: () => '/bin/agent-device',
    runFile: (_file, args) => {
      calls.push(args);
      if (!args.includes('--state-dir')) throw new Error('default daemon unavailable');
      return args[0] === 'session' ? payload([ios, { ...ios, name: 'unclaimed' }]) : '{"success":true}';
    },
  });
  try {
    await closeOwnedDeviceSessions({ platform: 'ios', id: 'U1' }, () => true, workspace);
    expect(calls.filter((args) => args[0] === 'close')).toEqual([
      [
        'close',
        '--session',
        ios.name,
        '--session-lock',
        'reject',
        '--platform',
        'ios',
        '--udid',
        'U1',
        '--state-dir',
        stateDir,
        '--json',
        '--daemon-transport',
        'socket',
      ],
    ]);
    expect(calls.filter((args) => args[0] === 'session' && args.includes(stateDir))).toHaveLength(2);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
