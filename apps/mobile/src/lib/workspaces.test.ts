import fixture from '../../mock-server/fixtures/status.json';

import {
  attentionGroups,
  deviceWarnings,
  devicesOf,
  livePlatforms,
  orderDevices,
  pathInCheckout,
  projectOf,
  repositoryRoots,
  runningBuild,
} from '@/lib/workspaces';
import type { EnvironmentState, StatusIssue, StatusPayload } from '@/protocol/types';

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

describe('pathInCheckout', () => {
  it('names the app folder inside its worktree or repository, and nothing at the checkout root', () => {
    const roots = ['/u/tlon-apps', '/u/stim'];
    expect(pathInCheckout(env('/u/tlon-apps/.worktrees/chat/apps/tlon-mobile'), roots)).toBe('apps/tlon-mobile');
    expect(pathInCheckout(env('/u/stim/.claude/worktrees/1123/apps/mobile'), roots)).toBe('apps/mobile');
    expect(pathInCheckout(env('/u/tlon-apps/apps/tlon-mobile'), roots)).toBe('apps/tlon-mobile');
    expect(pathInCheckout(env('/u/tlon-apps/.worktrees/chat'), roots)).toBeNull();
    expect(pathInCheckout(env('/u/stim'), roots)).toBeNull();
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

describe('livePlatforms', () => {
  it('names each platform with a running owned simulator or emulator once, across slots', () => {
    const booted = (udid: string) => ({
      name: `stim-w-${udid} (iPhone 18 Pro 27.0)`,
      udid,
      owned: true,
      state: 'Booted',
    });
    const iosOnly = env('/w', {
      ios: booted('A'),
      android: { name: 'stim-w', owned: true, physical: false, state: 'not-detected' },
      slots: [
        { slot: 'duo', ios: booted('B'), android: null },
        { slot: 'pixel', android: { name: 'Pixel 9', serial: 'P9', owned: false, physical: true, state: 'detected' } },
      ],
    });
    expect(livePlatforms(iosOnly)).toEqual(['ios']);
    const both = env('/w', {
      ios: booted('A'),
      slots: [{ slot: 'pixel', android: { name: 'stim-w-pixel', owned: true, physical: false, state: 'detected' } }],
    });
    expect(livePlatforms(both)).toEqual(['ios', 'android']);
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

describe('attentionGroups', () => {
  const issue = (workspace: string, over: Partial<StatusIssue> = {}): StatusIssue => ({
    code: 'avd-not-detected',
    severity: 'warning',
    message: 'owned AVD stim-app is not detected by adb',
    remedy: 'stim android',
    workspace,
    ...over,
  });

  it('puts live workspaces first, then errors, and turns each remedy into a command run from the workspace', () => {
    const groups = attentionGroups([
      env('/u/clean'),
      env('/u/idle', { issues: [issue('/u/idle')] }),
      env("/u/idle's error", {
        issues: [issue("/u/idle's error", { severity: 'error', remedy: 'stim guide errors teardown' })],
      }),
      env('/u/live', { live: true, issues: [issue('/u/live', { slot: 'fold', remedy: 'stim android --slot fold' })] }),
    ]);
    expect(groups.map((g) => g.path)).toEqual(['/u/live', "/u/idle's error", '/u/idle']);
    expect(groups[0].items).toEqual([
      {
        message: 'fold: owned AVD stim-app is not detected by adb',
        severity: 'warning',
        remedy: 'stim android --slot fold',
        command: "cd '/u/live' && stim android --slot fold",
      },
    ]);
    expect(groups[1].items[0].command).toBe("cd '/u/idle'\\''s error' && stim guide errors teardown");
  });

  it('falls back to the warning text, with no command, when stim reports no issues', () => {
    expect(attentionGroups([env('/u/old', { warnings: ['stale supervisor record for /u/old'] })])).toEqual([
      {
        path: '/u/old',
        live: false,
        items: [{ message: 'stale supervisor record for /u/old', severity: 'warning', remedy: null, command: null }],
      },
    ]);
  });
});
