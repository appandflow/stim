import fixture from '../../mock-server/fixtures/status.json';

import { pathInCheckout, projectOf, repositoryRoots, workspaceTitle, workspaceTitleAt } from '@/lib/workspace-names';
import {
  attentionGroups,
  deviceKey,
  deviceSource,
  deviceWarnings,
  devicesOf,
  isActive,
  livePlatforms,
  orderDevices,
  streamsFrames,
  unservedReason,
  runningBuild,
  shortUrl,
} from '@/lib/workspaces';
import type { EnvironmentState, StatusIssue, StatusPayload, WebBrowserState } from '@/protocol/types';

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

describe('workspaceTitle', () => {
  const roots = ['/u/stim', '/u/tlon-apps'];
  const linked = (path: string, checkout: string, branch?: string) =>
    env(path, { worktree: { path: checkout, repository: '/u/stim', ...(branch ? { branch } : {}) } });

  it('names a linked worktree by its branch, else by its folder', () => {
    expect(workspaceTitle(linked('/u/stim-1373/apps/mobile', '/u/stim-1373', 'feat/1373-zoom'), roots)).toBe(
      'feat/1373-zoom',
    );
    expect(workspaceTitle(linked('/u/wt-roadmap/apps/mobile', '/u/wt-roadmap'), roots)).toBe('wt-roadmap');
    expect(workspaceTitle(env('/u/tlon-apps/.worktrees/chat-perf/apps/tlon-mobile'), roots)).toBe('chat-perf');
    expect(workspaceTitle(env('/u/stim/.claude/worktrees/1123/apps/mobile', { worktree: null }), roots)).toBe('1123');
  });

  it('names a main checkout, nested app or not, by its project', () => {
    const onlyUnprovisioned = repositoryRoots({
      environments: [env('/u/stim/apps/mobile')],
      unprovisionedWorktrees: [{ path: '/u/stim-1373', repository: '/u/stim' }],
    });
    expect(workspaceTitle(env('/u/stim/apps/mobile'), onlyUnprovisioned)).toBe('stim');
    expect(workspaceTitle(env('/u/stim/apps/mobile', { worktree: null }), roots)).toBe('stim');
    expect(workspaceTitle(env('/u/tlon-apps'), roots)).toBe('tlon-apps');
  });

  it('falls back to the path when status does not list the workspace', () => {
    const status = { environments: [linked('/u/stim-1373/apps/mobile', '/u/stim-1373', 'feat/1373-zoom')] };
    expect(workspaceTitleAt('/u/stim-1373/apps/mobile', status)).toBe('feat/1373-zoom');
    expect(workspaceTitleAt('/u/tlon-apps/.worktrees/gone/apps/tlon-mobile', status)).toBe('gone');
    expect(workspaceTitleAt('/u/stim-1373/apps/mobile', null)).toBe('mobile');
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

describe('native macOS apps', () => {
  it('keeps native app state on Home and allows only verified running windows from a supporting server', () => {
    const macos: NonNullable<EnvironmentState['macos']> = {
      launchId: 'native-launch',
      product: 'MyApp',
      arguments: [],
      state: 'running',
      bundle: '/MyApp.app',
      bundleId: 'dev.myapp',
      executable: '/MyApp.app/Contents/MacOS/MyApp',
      build: { state: 'ok', startedAt: '2026-10-04T12:00:00Z' },
      app: { pid: 42, processToken: 'owned', startedAtMicros: 123 },
    };
    const workspace = env('/native', { macos });
    const [device] = devicesOf(workspace);
    expect(device).toMatchObject({ platform: 'macos', slot: 'default', name: 'MyApp', running: true });
    expect(device!.host).toBeUndefined();
    const [hosted] = devicesOf(
      env('/native', {
        macos: {
          ...macos,
          host: {
            machine: 'janics-mac-mini:7443',
            session: 'hosted-session',
            appSlot: 1,
            appAttempt: 'hosted-attempt',
            bundleId: 'dev.myapp.hosted1',
            agent: { driver: 'none', setting: 'hosting.agentDriver' },
          },
        },
      }),
    );
    expect(hosted).toMatchObject({ platform: 'macos', name: 'MyApp', host: 'janics-mac-mini' });
    expect(isActive(workspace)).toBe(true);
    expect(livePlatforms(workspace)).toEqual(['macos']);
    expect(streamsFrames(device!, ['macos-window'])).toBe(true);
    expect(streamsFrames(device!, [])).toBe(false);
    const [stopped] = devicesOf(env('/native', { macos: { ...macos, state: 'stopped' } }));
    expect(stopped).toMatchObject({ name: 'MyApp', running: false });
    expect(streamsFrames(stopped!, ['macos-window'])).toBe(false);
    expect(isActive(env('/native', { macos: { ...macos, state: 'stopped' } }))).toBe(false);
  });
});

describe('the Stim-owned Chrome', () => {
  it('is a Web device with its current page, its load failure and its driver', () => {
    const web: WebBrowserState = {
      browser: 'chrome',
      version: null,
      running: true,
      pid: 1,
      supervisorPid: 2,
      url: 'http://localhost:5173/',
      headless: true,
      viewport: 'desktop',
      profile: '/p',
      cdpEndpoint: 'http://127.0.0.1:8900',
      targetId: 'T',
      page: {
        url: 'http://localhost:5173/apps/groups/',
        state: 'failed',
        error: 'GET failed: net::ERR_CONNECTION_REFUSED',
      },
      activity: { state: 'driven', basis: ['cdp-client'] },
    };
    const [device] = devicesOf(env('/w', { live: true, web }));
    expect(device).toMatchObject({
      platform: 'web',
      slot: 'default',
      model: 'Web',
      running: true,
      owned: true,
      page: { url: 'http://localhost:5173/apps/groups/', error: 'GET failed: net::ERR_CONNECTION_REFUSED' },
      activity: { state: 'driven' },
    });
    expect(deviceSource(device!)).toBe('Chrome');
    expect(shortUrl(device!.page!.url)).toBe('localhost:5173/apps/groups');
    expect(livePlatforms(env('/w', { web }))).toEqual(['web']);
  });

  it('shows the in-app route the page moved to after its document loaded', () => {
    const web: WebBrowserState = {
      browser: 'chrome',
      version: null,
      running: true,
      pid: 1,
      supervisorPid: 2,
      url: 'http://localhost:5173/',
      headless: true,
      viewport: 'desktop',
      profile: '/p',
      cdpEndpoint: 'http://127.0.0.1:8900',
      targetId: 'T',
      page: { url: 'http://localhost:5173/', state: 'loaded', route: 'http://localhost:5173/apps/groups/' },
    };
    const [device] = devicesOf(env('/w', { live: true, web }));
    expect(device).toMatchObject({
      name: 'localhost:5173/apps/groups',
      page: { url: 'http://localhost:5173/apps/groups/', error: null },
    });
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

describe('physical devices', () => {
  const leased = payload.environments.find((e) => e.path.includes('chat-perf-demo'));
  if (!leased) throw new Error('fixture lost its workspace with physical devices');

  it('lists each leased phone after the owned devices, named, never owned, running only while connected', () => {
    const phones = devicesOf(leased).filter((d) => d.physical);
    expect(phones).toEqual([
      expect.objectContaining({
        platform: 'ios',
        slot: 'default',
        name: 'Old iPhone',
        model: 'iPhone 12 Pro',
        state: 'connected',
        running: true,
        owned: false,
      }),
      expect.objectContaining({ platform: 'android', slot: 'pixel', name: 'Pixel 9', running: false, owned: false }),
    ]);
    expect(deviceSource(phones[0]!)).toBe('iOS device');
    expect(livePlatforms(env('/w', { physicalDevices: leased.physicalDevices }))).toEqual([]);
  });

  it("streams a connected leased phone only when the Mac's stim-server lists its platform's feature", () => {
    const phones = devicesOf(leased).filter((d) => d.physical);
    const iphone = phones.find((d) => d.platform === 'ios')!;
    const android = { ...phones.find((d) => d.platform === 'android')!, running: true };
    const both = ['physical-ios', 'physical-android'];
    expect(streamsFrames(iphone, both)).toBe(true);
    expect(streamsFrames({ ...iphone, running: false }, both)).toBe(false);
    expect(streamsFrames(android, both)).toBe(true);
    expect(streamsFrames(android, ['physical-ios'])).toBe(false);
    expect(streamsFrames(iphone, ['physical-android'])).toBe(false);
    expect(streamsFrames(iphone, [])).toBe(false);
    expect(streamsFrames(android, null)).toBe(true);
    expect(streamsFrames({ ...android, running: false }, null)).toBe(false);
    expect(unservedReason(android)).toMatch(/Update stim-server/);
    expect(unservedReason({ ...android, running: false, state: 'disconnected' })).toBe('disconnected');
    const owned = devicesOf(leased).find((d) => !d.physical && d.owned)!;
    expect(streamsFrames(owned, [])).toBe(true);
  });

  it('keys a leased phone apart from the simulator in its slot, and a lease alone makes the workspace active', () => {
    const keys = devicesOf(leased).map(deviceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(isActive(env('/w', { physicalDevices: leased.physicalDevices }))).toBe(true);
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

  const order = (list: typeof devices) => orderDevices(list).map((d) => `${d.slot}/${d.platform}`);

  it('puts running devices first, then orders by platform and slot', () => {
    expect(order(devices)).toEqual(['duo/ios', 'tablet/ios', 'default/ios', 'default/android', 'tablet/android']);
  });

  it('keeps the order when only activity and drivers change', () => {
    const flipped = devices.map((d) =>
      d.slot === 'duo'
        ? { ...d, activity: { state: 'idle' as const, basis: [] } }
        : d.slot === 'tablet' && d.platform === 'ios'
          ? {
              ...d,
              activity: {
                state: 'driven' as const,
                driver: { tool: 'argent', pid: 7, since: '2026-09-27T10:00:00Z' },
                lastActivityAt: '2026-09-27T10:01:00Z',
                basis: [],
              },
            }
          : d,
    );
    expect(order(flipped)).toEqual(order(devices));
  });

  it('keeps the others in place when a device is added or removed', () => {
    const web = devicesOf(
      env('/w', { web: { browser: 'chrome', running: true, url: 'http://localhost:8081' } as WebBrowserState }),
    );
    const phone = devicesOf(
      env('/w', {
        slots: [
          { slot: 'aaa', ios: null, android: { name: 'Pixel', owned: false, physical: true, state: 'detected' } },
        ],
      }),
    );
    expect(order([...devices, ...web, ...phone])).toEqual([
      'duo/ios',
      'tablet/ios',
      'default/web',
      'aaa/android',
      'default/ios',
      'default/android',
      'tablet/android',
    ]);
    expect(order(devices.filter((d) => d.slot !== 'duo'))).toEqual(order(devices).filter((k) => !k.startsWith('duo/')));
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
