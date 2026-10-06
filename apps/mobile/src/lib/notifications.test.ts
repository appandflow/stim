import fixture from '../../mock-server/fixtures/status.json';

import type { AttentionMachine } from '@/lib/attention';
import type { ConnectionState } from '@/lib/connection';
import {
  DEFAULT_LEVELS,
  DEFAULT_PREFS,
  localNotifications,
  notificationRoute,
  notificationTimeMs,
  parsePrefs,
  type LocalNotification,
  type NotificationPrefs,
  type NotifyState,
} from '@/lib/notifications';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const OPEN: ConnectionState = {
  kind: 'open',
  protocol: 1,
  server: { name: 'm', version: '1', stim: '1' },
  actions: null,
  capabilities: [],
  features: [],
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

/** An iOS history whose newest `count` runs failed at the same Swift line, the newest at `at`. */
const looping = (at: number, count = 3): Partial<EnvironmentState> => {
  const runs = Array.from({ length: count }, (_, i) => ({
    platform: 'ios' as const,
    status: 'failed' as const,
    result: 'failed' as const,
    slot: 'default',
    configuration: 'Debug',
    cacheKey: null,
    phases: {},
    cacheHit: false as const,
    cacheSkipped: false,
    durationMs: 1000,
    fingerprint: null,
    startedAt: new Date(at - i * 60_000).toISOString(),
    finishedAt: new Date(at - i * 60_000).toISOString(),
    errorCode: 'STIM_BUILD_FAILED',
    diagnostics: [{ file: '/u/app/ios/AppDelegate.swift', line: 71, column: 3, message: 'boom' }],
  }));
  return { builds: { ios: runs }, lastBuilds: { ios: runs[0] } };
};

const sim = (app: 'running' | 'stopped', activity: 'driven' | 'idle' = 'idle') => ({
  name: 'stim-x (iPhone 18 Pro 27.0)',
  udid: 'U',
  owned: true,
  state: 'Booted',
  activity: { state: activity, basis: [] },
  app: { id: 'com.app', state: app },
});

/** Feeds each machine snapshot at its time through the notifier, like the app does. */
function run(
  steps: {
    at: number;
    machines: AttentionMachine[];
    prefs?: NotificationPrefs;
    pushed?: string[];
    awake?: number;
    minuteOfDay?: number;
  }[],
): LocalNotification[][] {
  let state: NotifyState = {};
  return steps.map(({ at, machines, prefs = ON, pushed = [], awake = T0, minuteOfDay = 12 * 60 }) => {
    const now = T0 + at;
    const result = localNotifications(
      state,
      machines.map((m) => ({
        mac: m,
        live: m.state.kind === 'open' && m.status !== null,
        pushed: pushed.includes(m.id),
      })),
      prefs,
      now,
      minuteOfDay,
      awake,
    );
    state = JSON.parse(JSON.stringify(result.state)) as NotifyState;
    return result.notifications;
  });
}

const texts = (steps: LocalNotification[][]) =>
  steps.map((notifications) =>
    notifications.map((n) => `${n.title}${n.subtitle ? ` (${n.subtitle})` : ''}: ${n.body}`),
  );

describe('localNotifications', () => {
  it('notifies a looping build once, updating in place, with its build details as the target', () => {
    const steps = run([
      { at: 0, machines: [mac([env(looping(T0 - 600_000, 1))])] },
      { at: 60_000, machines: [mac([env(looping(T0 + 60_000, 2))])] },
      { at: 120_000, machines: [mac([env(looping(T0 + 120_000))])] },
      { at: 180_000, machines: [mac([env(looping(T0 + 180_000, 4))])] },
    ]);
    expect(steps).toEqual([
      [],
      [],
      [
        {
          id: 'a:looping-ios:/u/app/.worktrees/login',
          title: 'feat/login',
          subtitle: 'MacBook Pro',
          body: 'Same Swift error 3x at AppDelegate.swift:71',
          quiet: true,
          thread: null,
          data: {
            ref: 'a',
            target: 'build',
            key: 'looping-ios:/u/app/.worktrees/login',
            path: '/u/app/.worktrees/login',
            platform: 'ios',
          },
        },
      ],
      [],
    ]);
  });

  it('no longer notifies a single failed build, log errors or a stopped app', () => {
    expect(
      texts(
        run([
          { at: 0, machines: [mac([env({ ios: sim('running') })])] },
          {
            at: 60_000,
            machines: [
              mac([
                env({ ...looping(T0 + 60_000, 1), ios: sim('stopped'), logs: { dir: '/l', errorsSinceMarker: 5 } }),
              ]),
            ],
          },
        ]),
      ),
    ).toEqual([[], []]);
  });

  it('notifies work started quietly, grouped per machine, and opens the device viewer', () => {
    const [, started] = run([
      { at: 0, machines: [mac([env({ ios: sim('running') })])] },
      { at: 60_000, machines: [mac([env({ ios: sim('running', 'driven') })])] },
    ]);
    expect(started).toEqual([
      expect.objectContaining({
        id: 'a:started:/u/app/.worktrees/login',
        quiet: true,
        thread: 'started:MacBook Pro',
        data: {
          ref: 'a',
          target: 'device',
          key: 'started:/u/app/.worktrees/login',
          path: '/u/app/.worktrees/login',
          platform: 'ios',
          slot: 'default',
        },
      }),
    ]);
  });

  it('notifies a machine that stays offline for a minute of open app time', () => {
    const offline = mac([], { state: { kind: 'waiting', retryInMs: 1000, reason: 'x' }, disconnectedAt: T0 });
    expect(
      texts(
        run([
          { at: 0, machines: [mac([])] },
          { at: 1000, machines: [offline] },
          { at: 30_000, machines: [offline] },
          { at: 61_000, machines: [offline] },
          { at: 120_000, machines: [offline] },
        ]),
      ),
    ).toEqual([[], [], [], ['MacBook Pro: Offline'], []]);

    expect(
      texts(
        run([
          { at: 0, machines: [mac([])] },
          { at: 1000, machines: [offline] },
          { at: 300_000, machines: [offline], awake: T0 + 299_000 },
          { at: 301_000, machines: [mac([])], awake: T0 + 299_000 },
        ]),
      ),
    ).toEqual([[], [], [], []]);
  });

  it('leaves what a machine pushes to the push, but still notifies its disconnection', () => {
    const offline = mac([env(looping(T0))], {
      state: { kind: 'waiting', retryInMs: 1000, reason: 'x' },
      disconnectedAt: T0,
    });
    expect(
      texts(
        run([
          { at: 0, machines: [mac([env()])], pushed: ['a'] },
          { at: 1000, machines: [mac([env(looping(T0))], { usage: usage(3) })], pushed: ['a'] },
          { at: 2000, machines: [offline], pushed: ['a'] },
          { at: 70_000, machines: [offline], pushed: ['a'] },
          { at: 80_000, machines: [mac([env(looping(T0))], { usage: usage(3) })] },
        ]),
      ),
    ).toEqual([[], [], [], ['MacBook Pro: Offline'], []]);
  });

  it('skips categories that are off, holds what lasts through quiet hours, and drops what started then', () => {
    const noLoops: NotificationPrefs = { ...ON, levels: { ...ON.levels, looping: 'off' } };
    const quiet = { ...ON, quietHours: { start: 22 * 60, end: 7 * 60 } };
    expect(
      texts(
        run([
          { at: 0, machines: [mac([env()])], prefs: noLoops },
          { at: 1000, machines: [mac([env(looping(T0))], { usage: usage(3) })], prefs: noLoops },
          { at: 2000, machines: [mac([env(looping(T0))], { usage: usage(3) })] },
        ]),
      ),
    ).toEqual([[], ["MacBook Pro: 3.0 GB free, below Stim's floor"], []]);
    expect(
      texts(
        run([
          { at: 0, machines: [mac([env({ ios: sim('running') })])], prefs: quiet, minuteOfDay: 23 * 60 },
          {
            at: 1000,
            machines: [mac([env({ ios: sim('running', 'driven') })], { usage: usage(3) })],
            prefs: quiet,
            minuteOfDay: 23 * 60,
          },
          { at: 2000, machines: [mac([env({ ios: sim('running', 'driven') })], { usage: usage(3) })], prefs: quiet },
        ]),
      ),
    ).toEqual([[], [], ["MacBook Pro: 3.0 GB free, below Stim's floor"]]);
  });

  it('delivers each category at its level: alert where the user raised it, silent by default', () => {
    const alerting: NotificationPrefs = { ...ON, levels: { ...ON.levels, started: 'alert' } };
    const quietness = (prefs: NotificationPrefs) =>
      run([
        { at: 0, machines: [mac([env({ ios: sim('running') })])], prefs },
        { at: 60_000, machines: [mac([env({ ios: sim('running', 'driven') })], { usage: usage(3) })], prefs },
        {
          at: 120_000,
          machines: [mac([env({ ios: sim('running', 'driven'), ...looping(T0 + 120_000) })], { usage: usage(3) })],
          prefs,
        },
      ]).map((step) => step.map((n) => [n.id, n.quiet]));
    expect(quietness(ON)).toEqual([
      [],
      [
        ['a:machine:disk', true],
        ['a:started:/u/app/.worktrees/login', true],
      ],
      [['a:looping-ios:/u/app/.worktrees/login', true]],
    ]);
    expect(quietness(alerting)[1]).toEqual([
      ['a:machine:disk', true],
      ['a:started:/u/app/.worktrees/login', false],
    ]);
  });

  it('sums up more than three at once', () => {
    const broken = (name: string) => env({ path: `/u/app/.worktrees/${name}`, worktree: undefined, ...looping(T0) });
    expect(
      texts(
        run([
          { at: 0, machines: [mac([])] },
          { at: 1000, machines: [mac([broken('a'), broken('b'), broken('c'), broken('d')])] },
        ]),
      ),
    ).toEqual([[], ['Stim: 4 things need a look']]);
  });
});

describe('parsePrefs', () => {
  it('keeps notifications on for preferences saved before the categories, at every default level', () => {
    expect(parsePrefs(JSON.stringify({ enabled: true, events: ['build-failed'], agentOnly: true }))).toEqual({
      ...DEFAULT_PREFS,
      enabled: true,
    });
    expect(
      parsePrefs(
        JSON.stringify({
          enabled: true,
          categories: ['stuck', 'bogus'],
          stuckMinutes: 30,
          quietHours: { start: 1, end: 2 },
        }),
      ),
    ).toEqual({
      enabled: true,
      levels: {
        started: 'off',
        stuck: 'silent',
        looping: 'off',
        finished: 'off',
        machine: 'off',
        control: 'off',
        attention: 'silent',
      },
      stuckMinutes: 30,
      quietHours: { start: 1, end: 2 },
    });
    expect(parsePrefs(JSON.stringify({ stuckMinutes: 0, quietHours: { start: 1440, end: 0 } }))).toEqual(DEFAULT_PREFS);
  });

  it('moves on/off categories to levels: on takes the default level, off stays off', () => {
    const migrated = parsePrefs(JSON.stringify({ enabled: true, categories: ['started', 'machine', 'control'] }));
    expect(migrated.levels).toEqual({
      started: 'silent',
      stuck: 'off',
      looping: 'off',
      finished: 'off',
      machine: 'silent',
      control: 'silent',
      attention: 'silent',
    });
    expect(parsePrefs(JSON.stringify(migrated))).toEqual(migrated);
  });

  it('keeps stored levels over categories, and gives an unknown or missing level its default', () => {
    expect(
      parsePrefs(
        JSON.stringify({ levels: { stuck: 'alert', machine: 'off', looping: 'loud' }, categories: ['started'] }),
      ).levels,
    ).toEqual({ ...DEFAULT_LEVELS, stuck: 'alert', machine: 'off' });
  });
});

describe('notificationRoute', () => {
  it.each([1_791_288_000, 1_791_288_000_000])('opens device replay at the delivery time from %s', (delivered) => {
    expect(
      notificationRoute(
        { ref: 'a', target: 'device', path: '/w', platform: 'ios' },
        ['a'],
        notificationTimeMs(delivered),
      ),
    ).toEqual({
      pathname: '/mac/[id]/device',
      params: { id: 'a', path: '/w', platform: 'ios', slot: 'default', at: '1791288000000' },
    });
  });
  it.each([
    ['machine', { pathname: '/mac/[id]', params: { id: 'a' } }],
    ['workspace', { pathname: '/mac/[id]/workspace', params: { id: 'a', path: '/w' } }],
    ['logs', { pathname: '/mac/[id]/logs', params: { id: 'a', path: '/w', errors: '1' } }],
    ['build', { pathname: '/mac/[id]/build', params: { id: 'a', path: '/w', platform: 'ios' } }],
    ['url', { url: 'https://github.com/appandflow/stim/pull/2625' }],
    ['home', { pathname: '/mac/[id]/workspace', params: { id: 'a', path: '/w' } }],
  ])('does not add replay time to %s', (target, expected) => {
    const data = { ref: 'a', target, path: '/w', platform: 'ios', url: 'https://github.com/appandflow/stim/pull/2625' };
    expect(notificationRoute(data, ['a'], 1_791_288_000_000)).toEqual(expected);
  });

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
    expect(
      notificationRoute({ ref: 'a', target: 'device', path: '/w', platform: 'android', slot: 'tab' }, macs),
    ).toEqual({
      pathname: '/mac/[id]/device',
      params: { id: 'a', path: '/w', platform: 'android', slot: 'tab' },
    });
    expect(notificationRoute({ ref: 'a', target: 'build', path: '/w', platform: 'ios' }, macs)).toEqual({
      pathname: '/mac/[id]/build',
      params: { id: 'a', path: '/w', platform: 'ios' },
    });
    expect(
      notificationRoute({ ref: 'a', target: 'device', path: '/w', platform: 'web', slot: 'default' }, macs),
    ).toEqual({
      pathname: '/mac/[id]/device',
      params: { id: 'a', path: '/w', platform: 'web', slot: 'default' },
    });
    expect(notificationRoute({ ref: 'gone', target: 'machine' }, macs)).toEqual({ pathname: '/' });
    expect(notificationRoute({ ref: 'a', target: 'home' }, macs)).toEqual({ pathname: '/' });
    expect(notificationRoute(undefined, macs)).toEqual({ pathname: '/' });
  });

  it('opens only a GitHub pull request in the browser, and the workspace for any other link', () => {
    const url = 'https://github.com/appandflow/stim/pull/1648';
    expect(notificationRoute({ ref: 'a', target: 'url', path: '/w', url }, ['a'])).toEqual({ url });
    expect(
      notificationRoute({ ref: 'a', target: 'url', path: '/w', url: 'https://evil.example/pull/1' }, ['a']),
    ).toEqual({
      pathname: '/mac/[id]/workspace',
      params: { id: 'a', path: '/w' },
    });
  });
});
