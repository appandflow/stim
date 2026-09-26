import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSupervisorState } from '../commands/stop.ts';
import { readWorkspaceLaunches, writeWorkspaceLaunch, type WorkspaceLaunchRecord } from '../supervisor/state.ts';
import { siblingPlatformSlots } from '../engine/slot-launch.ts';
import { upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

let stimHome: string;
let root: string;

beforeEach(() => {
  stimHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  root = mkdtempSync(join(tmpdir(), 'stim-project-'));
  process.env.STIM_HOME = stimHome;
});

afterEach(() => {
  rmSync(stimHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function launch(appId: string, deviceId: string): WorkspaceLaunchRecord {
  return {
    appId,
    deviceId,
    metroPort: 8082,
    release: false,
    launchedAt: '2026-09-04T12:00:00.000Z',
  };
}

test('workspace launch writes preserve the other platform under the state lock', () => {
  writeWorkspaceState(root, { supervisor: { pid: 42 } });
  writeWorkspaceLaunch(root, 'ios', launch('com.example.ios', 'U1'));
  writeWorkspaceLaunch(root, 'android', launch('com.example.android', 'emulator-5554'));

  expect(readWorkspaceLaunches(root)).toEqual({
    ios: launch('com.example.ios', 'U1'),
    android: launch('com.example.android', 'emulator-5554'),
  });
  expect(readWorkspaceState(root)?.supervisor).toEqual({ pid: 42 });
});

test('invalid launch entries are ignored instead of becoming reload targets', () => {
  writeWorkspaceState(root, {
    launches: {
      ios: { appId: 'com.example.ios' },
      android: launch('com.example.android', 'emulator-5554'),
    },
  });

  expect(readWorkspaceLaunches(root)).toEqual({ android: launch('com.example.android', 'emulator-5554') });
});

test('a record written before deepLinkUrl was dropped is still a reload target', () => {
  writeWorkspaceState(root, {
    launches: {
      android: {
        ...launch('com.example.android', 'emulator-5554'),
        deepLinkUrl: 'example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082',
      },
    },
  });

  expect(readWorkspaceLaunches(root).android).toMatchObject(launch('com.example.android', 'emulator-5554'));
});

test('stop clears launch eligibility with the supervisor record', () => {
  writeWorkspaceState(root, { supervisor: { pid: 42 } });
  writeWorkspaceLaunch(root, 'ios', launch('com.example.ios', 'U1'));

  clearSupervisorState(root);

  expect(readWorkspaceLaunches(root)).toEqual({});
  expect(readWorkspaceState(root)).toBeNull();
});

test('launches in named slots coexist with default launches and share the supervisor', () => {
  writeWorkspaceState(root, { supervisor: { pid: 42 } });
  writeWorkspaceLaunch(root, 'ios', launch('app', 'DEFAULT'));
  writeWorkspaceLaunch(root, 'ios', launch('app', 'PHONE'), 'phone');
  writeWorkspaceLaunch(root, 'ios', launch('app', 'TABLET'), 'tablet');
  writeWorkspaceLaunch(root, 'ios', launch('app', 'PHONE-RELAUNCH'), 'phone');
  expect(Object.entries(readWorkspaceLaunches(root)).map(([key, value]) => [key, value.deviceId])).toEqual([
    ['ios', 'DEFAULT'],
    ['ios:phone', 'PHONE-RELAUNCH'],
    ['ios:tablet', 'TABLET'],
  ]);
  expect(readWorkspaceState(root)?.supervisor).toEqual({ pid: 42 });
  expect(() => writeWorkspaceLaunch(root, 'ios', launch('app', 'INVALID'), '../phone')).toThrow(/device slot/);
  expect(Object.keys(readWorkspaceLaunches(root))).toHaveLength(3);
});

test('a sibling slot shares Metro only while its collector or lease is live, not for a stopped device record', () => {
  upsertProject(root, {
    platforms: { android: { avdName: 'stim-a', owned: true } },
    deviceSlots: { parked: { android: { avdName: 'stim-b', owned: true } } },
  });
  const collector = { pid: 1, processToken: 't' };
  writeWorkspaceState(root, {
    collectors: { android: collector, 'android:second': collector, 'ios:tablet': collector },
    deviceLeases: { 'android:hardware': { id: 'R5C', token: 'lease', kind: 'declared' } },
  });
  expect(siblingPlatformSlots(root, 'android')).toEqual(['hardware', 'second']);
  expect(siblingPlatformSlots(root, 'android', 'second')).toEqual(['default', 'hardware']);
  expect(siblingPlatformSlots(root, 'ios', 'tablet')).toEqual([]);
});
