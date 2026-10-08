import type { HomeItem } from '@/lib/home';
import { platformStates, worktreeRowLabel, worktreeRowSummary } from '@/lib/worktree-row';
import type { EnvironmentState } from '@/protocol/types';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  worktree: { path: '/w' },
  ...extra,
});
const item = (e: EnvironmentState): HomeItem => ({
  key: `mac\n${e.path}`,
  macId: 'mac',
  macName: 'Mac mini',
  project: 'stim',
  title: 'feat/x',
  inCheckout: e.path.replace('/w/', ''),
  env: e,
});
const booted = { name: 'sim', udid: 'u', owned: true, state: 'Booted' };
const shutdown = { name: 'sim', udid: 'u', owned: true, state: 'Shutdown' };
const macos = (state: string, build: string) =>
  ({
    launchId: 'm',
    product: 'App',
    state,
    build: { state: build, startedAt: ago(HOUR) },
  }) as EnvironmentState['macos'];
const failedBuild = (platform: string, at = HOUR) =>
  ({
    [platform]: {
      platform,
      status: 'failed',
      startedAt: ago(at),
      finishedAt: ago(at),
    },
  }) as EnvironmentState['lastBuilds'];

describe('platformStates', () => {
  it('lists nothing for an app that ran nothing, and only the platforms that ran', () => {
    expect(platformStates(env('/w/a'), NOW)).toEqual([]);
    expect(platformStates(env('/w/a', { live: true, ios: booted }), NOW)).toEqual([
      { platform: 'ios', kind: 'running' },
    ]);
  });

  it('gives each platform its own state, in iOS, Android, macOS order', () => {
    const states = platformStates(
      env('/w/a', {
        live: true,
        macos: macos('running', 'ok'),
        ios: shutdown,
        android: undefined,
      }),
      NOW,
    );
    expect(states).toEqual([
      { platform: 'ios', kind: 'idle' },
      { platform: 'macos', kind: 'running' },
    ]);
  });

  it('shows a macOS build as building and a failed build as failed while active, or for a day', () => {
    expect(platformStates(env('/w/a', { macos: macos('stopped', 'running') }), NOW)).toEqual([
      { platform: 'macos', kind: 'building' },
    ]);
    expect(
      platformStates(
        env('/w/a', {
          live: true,
          ios: booted,
          lastBuilds: failedBuild('android'),
        }),
        NOW,
      ),
    ).toEqual([
      { platform: 'ios', kind: 'running' },
      { platform: 'android', kind: 'failed' },
    ]);
    expect(platformStates(env('/w/a', { lastBuilds: failedBuild('android', 3 * 24 * HOUR) }), NOW)).toEqual([
      { platform: 'android', kind: 'idle' },
    ]);
  });
});

describe('worktreeRowSummary', () => {
  const desktop = (extra: Partial<EnvironmentState> = {}) =>
    env('/w/apps/desktop', {
      live: true,
      macos: macos('running', 'ok'),
      ...extra,
    });
  const mobile = (extra: Partial<EnvironmentState> = {}) =>
    env('/w/apps/mobile', { live: true, ios: booted, ...extra });

  it('keeps a single app as it is', () => {
    const summary = worktreeRowSummary([item(mobile())], NOW, null);
    expect(summary.lead.env.path).toBe('/w/apps/mobile');
    expect(summary.status.kind).toBe('running');
    expect(summary.platforms).toEqual([{ platform: 'ios', kind: 'running' }]);
  });

  it('summarizes two running apps as one Running row with a dot per platform', () => {
    const summary = worktreeRowSummary([item(desktop()), item(mobile())], NOW, null);
    expect(summary.status.kind).toBe('running');
    expect(summary.platforms).toEqual([
      { platform: 'ios', kind: 'running' },
      { platform: 'macos', kind: 'running' },
    ]);
    expect(worktreeRowLabel('feat/x', summary, null)).toBe('feat/x, Running, iOS running, macOS running');
  });

  it('leads with the building app, over a running and an idle one', () => {
    const building = mobile({
      build: {
        platform: 'ios',
        slot: 'default',
        state: 'running',
        phase: 'compile',
        startedAt: ago(1000),
      } as EnvironmentState['build'],
    });
    const idle = env('/w/apps/idle', { ios: shutdown });
    const summary = worktreeRowSummary([item(idle), item(desktop()), item(building)], NOW, null);
    expect(summary.lead.env.path).toBe('/w/apps/mobile');
    expect(summary.status.kind).toBe('building');
    expect(summary.platforms).toEqual([
      { platform: 'ios', kind: 'building' },
      { platform: 'macos', kind: 'running' },
    ]);
  });

  it('puts a failed app first and keeps its platform failed when another app runs it', () => {
    const failed = mobile({ ios: shutdown, lastBuilds: failedBuild('ios') });
    const summary = worktreeRowSummary(
      [item(desktop()), item(failed), item(mobile({ path: '/w/apps/other' } as never))],
      NOW,
      null,
    );
    expect(summary.lead.env.path).toBe('/w/apps/mobile');
    expect(summary.platforms.find((p) => p.platform === 'ios')).toEqual({
      platform: 'ios',
      kind: 'failed',
    });
    expect(summary.problems.map((p) => p.text)).toContain('iOS build failed');
  });

  it('does not let a stopped app with an old failed build lead over a running app', () => {
    const stale = env('/w/apps/stale', { ios: shutdown, lastBuilds: failedBuild('ios', 3 * 24 * HOUR) });
    const summary = worktreeRowSummary([item(stale), item(desktop())], NOW, null);
    expect(summary.lead.env.path).toBe('/w/apps/desktop');
    expect(summary.status.kind).toBe('running');
  });

  it('sums errors and warnings across apps, and names a shared problem once', () => {
    const summary = worktreeRowSummary(
      [
        item(desktop({ logs: { errorsSinceMarker: 2 } as never, warnings: ['a'] })),
        item(
          mobile({
            logs: { errorsSinceMarker: 3 } as never,
            warnings: ['b', 'c'],
          }),
        ),
      ],
      NOW,
      null,
    );
    expect(summary.problems).toEqual([
      { kind: 'errors', text: '5 errors', tone: 'error' },
      { kind: 'warnings', text: '3 warnings', tone: 'warning' },
    ]);
  });

  it('shows every app idle when none is active', () => {
    const summary = worktreeRowSummary([item(env('/w/a', { ios: shutdown })), item(env('/w/b'))], NOW, null);
    expect(summary.status.kind).toBe('idle');
    expect(summary.platforms).toEqual([{ platform: 'ios', kind: 'idle' }]);
  });
});
