import fixture from '../../mock-server/fixtures/status.json';

import {
  deviceWarnings,
  devicesOf,
  groupByProject,
  orderDevices,
  projectOf,
  repositoryRoots,
  runningBuild,
  workspaceNames,
} from '@/lib/workspaces';
import type { EnvironmentState, StatusPayload } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  ...extra,
});

describe('projectOf', () => {
  it('maps worktrees and checkouts inside a known repository to that repository', () => {
    const roots = repositoryRoots({
      environments: [env('/u/tlon-apps/.worktrees/chat-perf/apps/tlon-mobile')],
      unprovisionedWorktrees: [{ path: '/u/stim/.claude/worktrees/1123-mobile-app' }],
    });
    expect(roots).toEqual(['/u/tlon-apps', '/u/stim']);
    expect(projectOf(env('/u/hinges/example'), ['/u/hinges', '/u/hinges/example']).key).toBe('/u/hinges');
    expect(projectOf(env('/u/tlon-apps/.worktrees/chat-perf/apps/tlon-mobile'), roots).key).toBe('/u/tlon-apps');
    expect(projectOf(env('/u/tlon-apps/apps/tlon-mobile'), roots)).toEqual({ key: '/u/tlon-apps', name: 'tlon-apps' });
    expect(projectOf(env('/u/stim/apps/mobile'), roots).name).toBe('stim');
    expect(projectOf(env('/u/tlon-apps-2'), roots)).toEqual({ key: '/u/tlon-apps-2', name: 'tlon-apps-2' });
  });
});

describe('groupByProject', () => {
  it('groups the captured status by repository with live projects and workspaces first', () => {
    const groups = groupByProject(payload);
    expect(groups.map((g) => g.name)).toEqual(['stim', 'tlon-apps', 'example', 'helloworld', 'react-native-hinges']);
    const tlon = groups.find((g) => g.name === 'tlon-apps');
    expect(tlon?.liveCount).toBe(3);
    expect(tlon?.workspaces.map((w) => workspaceNames(w.path).title).slice(0, 3)).toEqual([
      'chat-perf-demo',
      'wide-insets',
      'wide-split-layout',
    ]);
    const firstIdle = groups.findIndex((g) => g.liveCount === 0);
    expect(groups.slice(firstIdle).every((g) => g.liveCount === 0)).toBe(true);
  });
});

describe('groupByProject names', () => {
  it('tells apart projects whose folders share a name', () => {
    const groups = groupByProject({ ...payload, environments: [env('/u/a/example'), env('/u/b/example')] });
    expect(groups.map((g) => g.name)).toEqual(['a/example', 'b/example']);
  });
});

describe('devicesOf', () => {
  it('lists slot devices and reads the model from the owned simulator name', () => {
    const devices = devicesOf(
      env('/w', {
        ios: { name: 'stim-w (iPhone 18 Pro 27.0)', udid: 'A', owned: true, state: 'Booted' },
        slots: [
          {
            slot: 'ipad',
            ios: { name: 'stim-w-ipad (iPad Pro 11-inch (M5) 27.0)', udid: 'B', owned: true, state: 'Shutdown' },
            android: null,
          },
        ],
      }),
    );
    expect(devices.map((d) => [d.slot, d.model, d.running])).toEqual([
      ['default', 'iPhone 18 Pro 27.0', true],
      ['ipad', 'iPad Pro 11-inch (M5) 27.0', false],
    ]);
  });
});

describe('runningBuild', () => {
  it('attaches a running build only to the device it targets', () => {
    const building = payload.environments.find((e) => e.path.includes('1123-mobile-app'));
    if (!building) throw new Error('fixture lost its building workspace');
    expect(runningBuild(building, { platform: 'ios', slot: 'phone' })?.phase).toBe('install');
    expect(runningBuild(building, { platform: 'ios', slot: 'default' })).toBeNull();
  });
});

describe('orderDevices and deviceWarnings', () => {
  const devices = devicesOf(
    env('/w', {
      ios: { name: 'stim-w (iPhone 18 Pro 27.0)', udid: 'A', owned: true, state: 'Shutdown' },
      android: { name: 'stim-w-app', owned: true, physical: false, state: 'not-detected' },
      slots: [
        {
          slot: 'tablet',
          ios: { name: 'stim-w-tablet (iPad Pro 27.0)', udid: 'B', owned: true, state: 'Booted' },
          android: { name: 'stim-w-app-tablet', owned: true, physical: false, state: 'not-detected' },
        },
        {
          slot: 'duo',
          ios: {
            name: 'stim-w-duo (iPhone Duo 27.1)',
            udid: 'C',
            owned: true,
            state: 'Booted',
            activity: { state: 'driven', basis: [] },
          },
          android: null,
        },
      ],
    }),
  );

  it('puts driven devices first, then running, then stopped, by slot inside each group', () => {
    expect(orderDevices(devices).map((d) => `${d.slot}/${d.platform}`)).toEqual([
      'duo/ios',
      'tablet/ios',
      'default/android',
      'default/ios',
      'tablet/android',
    ]);
  });

  it('gives a warning to the device with the longest name it mentions', () => {
    const { byDevice, general } = deviceWarnings(
      ['owned AVD stim-w-app-tablet is not detected by adb', 'owned AVD stim-w-app is not detected', 'Metro is slow'],
      devices,
    );
    expect([...byDevice].map(([d, w]) => [d.name, w])).toEqual([
      ['stim-w-app-tablet', ['owned AVD stim-w-app-tablet is not detected by adb']],
      ['stim-w-app', ['owned AVD stim-w-app is not detected']],
    ]);
    expect(general).toEqual(['Metro is slow']);
  });
});
