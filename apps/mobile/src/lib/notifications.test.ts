import fixture from '../../mock-server/fixtures/status.json';

import { homeAttention, type AttentionMachine } from '@/lib/attention';
import type { ConnectionState } from '@/lib/connection';
import {
  DEFAULT_PREFS,
  localNotifications,
  notificationRoute,
  type NotificationPrefs,
  type NotifyState,
} from '@/lib/notifications';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const OPEN: ConnectionState = {
  kind: 'open',
  server: { name: 'm', version: '1', stim: '1' },
  actions: null,
  capabilities: [],
  deviceId: null,
};
const payload = fixture.payload as StatusPayload;
const ON: NotificationPrefs = { ...DEFAULT_PREFS, enabled: true };

const env = (extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path: '/u/app/.worktrees/login',
  live: true,
  memoryMb: 0,
  warnings: [],
  worktree: {
    path: '/u/app/.worktrees/login',
    branch: 'feat/login',
    repository: '/u/app',
  } as EnvironmentState['worktree'],
  ...extra,
});

const usage = (freeGb: number): MachineUsage => ({
  volumes: [{ mount: '/', holds: [], freeBytes: freeGb * 1e9, totalBytes: 1e12 }],
  memory: { totalBytes: 1, usedBytes: null, pressure: null },
  load: { avg1: 0, avg5: 0, avg15: 0, cpus: 1 },
  sampledAt: '',
});

const mac = (environments: EnvironmentState[], extra: Partial<AttentionMachine> = {}): AttentionMachine => ({
  id: 'a',
  name: 'MacBook Pro',
  state: OPEN,
  missing: false,
  status: { ...payload, environments, unprovisionedWorktrees: [] },
  usage: usage(200),
  home: '/u',
  disconnectedAt: null,
  seenAt: null,
  ...extra,
});

const failed = (at: number) => ({
  ios: {
    platform: 'ios' as const,
    status: 'failed' as const,
    cacheHit: false as const,
    cacheSkipped: false,
    durationMs: 1000,
    fingerprint: null,
    startedAt: new Date(at).toISOString(),
    finishedAt: new Date(at).toISOString(),
    errorCode: 'STIM_BUILD_FAILED',
  },
});

const sim = (app: 'running' | 'stopped', activity: 'driven' | 'idle' = 'idle') => ({
  name: 'stim-x (iPhone 18 Pro 27.0)',
  udid: 'U',
  owned: true,
  state: 'Booted',
  activity: { state: activity, basis: [] },
  app: { id: 'com.app', state: app },
});

/** Feeds each machine snapshot at its time through home's attention and the notifier, like the app does. */
function run(
  steps: { at: number; machines: AttentionMachine[]; prefs?: NotificationPrefs; pushed?: string[]; awake?: number }[],
) {
  let state: NotifyState = {};
  return steps.map(({ at, machines, prefs = ON, pushed = [], awake = T0 }) => {
    const now = T0 + at;
    const result = localNotifications(
      state,
      homeAttention(machines, now),
      machines.map((m) => ({
        id: m.id,
        live: m.state.kind === 'open' && m.status !== null,
        pushed: pushed.includes(m.id),
      })),
      prefs,
      now,
      awake,
    );
    state = result.state;
    return result.notifications.map((n) => `${n.title}${n.subtitle ? ` (${n.subtitle})` : ''}: ${n.body}`);
  });
}

describe('localNotifications', () => {
  it('stays quiet about what is wrong at the first check, then notifies each new failure once', () => {
    expect(
      run([
        { at: 0, machines: [mac([env({ lastBuilds: failed(T0 - 60_000) })])] },
        { at: 5000, machines: [mac([env({ lastBuilds: failed(T0 - 60_000) })])] },
        { at: 10_000, machines: [mac([env({ lastBuilds: failed(T0 + 8000) })])] },
        { at: 15_000, machines: [mac([env({ lastBuilds: failed(T0 + 8000) })])] },
        { at: 20_000, machines: [mac([env({ lastBuilds: failed(T0 + 18_000) })])] },
      ]),
    ).toEqual([
      [],
      [],
      ['feat/login (MacBook Pro): iOS build failed (STIM_BUILD_FAILED)'],
      [],
      ['feat/login (MacBook Pro): iOS build failed (STIM_BUILD_FAILED)'],
    ]);
  });

  it('treats a problem that clears briefly as the same one, and one gone two minutes as new', () => {
    const stopped = mac([env({ ios: sim('stopped') })]);
    const running = mac([env({ ios: sim('running') })]);
    expect(
      run([
        { at: 0, machines: [running] },
        { at: 1000, machines: [stopped] },
        { at: 2000, machines: [running] },
        { at: 60_000, machines: [stopped] },
        { at: 70_000, machines: [running] },
        { at: 200_000, machines: [running] },
        { at: 210_000, machines: [stopped] },
      ]),
    ).toEqual([
      [],
      ['feat/login (MacBook Pro): App not running on iPhone 18 Pro 27.0'],
      [],
      [],
      [],
      [],
      ['feat/login (MacBook Pro): App not running on iPhone 18 Pro 27.0'],
    ]);
  });

  it('holds what a cached or disconnected status reported until the live status says otherwise', () => {
    const broken = [env({ lastBuilds: failed(T0 + 1000) })];
    expect(
      run([
        { at: 0, machines: [mac([env()])] },
        { at: 2000, machines: [mac(broken)] },
        { at: 400_000, machines: [mac(broken, { status: null, seenAt: T0 })] },
        { at: 800_000, machines: [mac(broken)] },
      ]),
    ).toEqual([[], ['feat/login (MacBook Pro): iOS build failed (STIM_BUILD_FAILED)'], [], []]);
  });

  it('notifies a machine that stays offline for a minute of open app time', () => {
    const offline = mac([], { state: { kind: 'waiting', retryInMs: 1000, reason: 'x' }, disconnectedAt: T0 });
    expect(
      run([
        { at: 0, machines: [mac([])] },
        { at: 1000, machines: [offline] },
        { at: 30_000, machines: [offline] },
        { at: 61_000, machines: [offline] },
        { at: 120_000, machines: [offline] },
      ]),
    ).toEqual([[], [], [], ['MacBook Pro: Offline'], []]);

    expect(
      run([
        { at: 0, machines: [mac([])] },
        { at: 1000, machines: [offline] },
        { at: 300_000, machines: [offline], awake: T0 + 299_000 },
        { at: 301_000, machines: [mac([])], awake: T0 + 299_000 },
      ]),
    ).toEqual([[], [], [], []]);
  });

  it('notifies log errors once the count settles, then new ones after a cooldown', () => {
    const logs = (count: number) => [mac([env({ logs: { dir: '/l', errorsSinceMarker: count } })])];
    expect(
      run([
        { at: 0, machines: logs(0) },
        { at: 1000, machines: logs(2) },
        { at: 4000, machines: logs(3) },
        { at: 15_000, machines: logs(3) },
        { at: 20_000, machines: logs(7) },
        { at: 40_000, machines: logs(7) },
        { at: 316_000, machines: logs(7) },
      ]),
    ).toEqual([
      [],
      [],
      [],
      ['feat/login (MacBook Pro): 3 errors in the logs'],
      [],
      [],
      ['feat/login (MacBook Pro): 4 new errors in the logs'],
    ]);
  });

  it('skips events that are off, and stays quiet about them when they are turned on', () => {
    const noBuilds = { ...ON, events: ON.events.filter((e) => e !== 'build-failed') };
    expect(
      run([
        { at: 0, machines: [mac([env()])], prefs: noBuilds },
        { at: 1000, machines: [mac([env({ lastBuilds: failed(T0) })], { usage: usage(3) })], prefs: noBuilds },
        { at: 2000, machines: [mac([env({ lastBuilds: failed(T0) })], { usage: usage(3) })] },
      ]),
    ).toEqual([[], ["MacBook Pro: 3.0 GB free, below Stim's floor"], []]);
  });

  it('keeps only workspaces an agent drives with the agent filter', () => {
    const agentOnly = { ...ON, agentOnly: true };
    const envs = (app: 'running' | 'stopped') => [
      env({ ios: sim(app, 'idle') }),
      env({ path: '/u/app/.worktrees/agent', worktree: undefined, ios: sim(app, 'driven') }),
    ];
    expect(
      run([
        { at: 0, machines: [mac(envs('running'))], prefs: agentOnly },
        { at: 1000, machines: [mac(envs('stopped'))], prefs: agentOnly },
      ]),
    ).toEqual([[], ['agent (MacBook Pro): App not running on iPhone 18 Pro 27.0']]);
  });

  it('leaves what a machine pushes to the push, but still notifies its disconnection', () => {
    const offline = mac([env({ lastBuilds: failed(T0) })], {
      state: { kind: 'waiting', retryInMs: 1000, reason: 'x' },
      disconnectedAt: T0,
    });
    expect(
      run([
        { at: 0, machines: [mac([env()])], pushed: ['a'] },
        { at: 1000, machines: [mac([env({ lastBuilds: failed(T0) })])], pushed: ['a'] },
        { at: 2000, machines: [offline], pushed: ['a'] },
        { at: 70_000, machines: [offline], pushed: ['a'] },
        { at: 80_000, machines: [mac([env({ lastBuilds: failed(T0) })])] },
      ]),
    ).toEqual([[], [], [], ['MacBook Pro: Offline'], []]);
  });

  it('sums up more than three at once', () => {
    const broken = (name: string) =>
      env({ path: `/u/app/.worktrees/${name}`, worktree: undefined, lastBuilds: failed(T0) });
    expect(
      run([
        { at: 0, machines: [mac([])] },
        { at: 1000, machines: [mac([broken('a'), broken('b'), broken('c'), broken('d')])] },
      ]),
    ).toEqual([[], ['Stim: 4 problems need attention']]);
  });
});

describe('notificationRoute', () => {
  it('opens the screen a notification names on a paired machine, and home otherwise', () => {
    const macs = ['a'];
    expect(notificationRoute({ ref: 'a', target: 'machine' }, macs)).toEqual({
      pathname: '/mac/[id]',
      params: { id: 'a' },
    });
    expect(notificationRoute({ ref: 'a', target: 'workspace', path: '/w' }, macs)).toEqual({
      pathname: '/mac/[id]/workspace',
      params: { id: 'a', path: '/w' },
    });
    expect(notificationRoute({ ref: 'a', target: 'logs', path: '/w' }, macs)).toEqual({
      pathname: '/mac/[id]/logs',
      params: { id: 'a', path: '/w', errors: '1' },
    });
    expect(notificationRoute({ ref: 'gone', target: 'machine' }, macs)).toEqual({ pathname: '/' });
    expect(notificationRoute({ ref: 'a', target: 'home' }, macs)).toEqual({ pathname: '/' });
    expect(notificationRoute(undefined, macs)).toEqual({ pathname: '/' });
  });
});
