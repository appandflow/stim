import type { HomeItem } from '@/lib/home';
import { checkoutProjects, homeSections, rowDevices, rowLabel, rowProblems, rowStatus } from '@/lib/home-list';
import type { BuildReport, DeviceActivity, EnvironmentState, LastBuild, PhysicalDeviceState } from '@/protocol/types';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  ...extra,
});
const item = (project: string, title: string, e: EnvironmentState, inCheckout: string | null = null): HomeItem => ({
  key: `mac\n${e.path}`,
  macId: 'mac',
  macName: 'Mac mini',
  project,
  title,
  inCheckout,
  env: e,
});
const driven = (tool: string, sinceMs: number): DeviceActivity => ({
  state: 'driven',
  driver: { tool, pid: 1, since: ago(sinceMs) },
  basis: [],
});
const idle = (lastMs: number): DeviceActivity => ({ state: 'idle', lastActivityAt: ago(lastMs), basis: [] });
const booted = (activity?: DeviceActivity) => ({ name: 'sim', udid: 'u', owned: true, state: 'Booted', activity });
const build = (extra: Partial<BuildReport> = {}): BuildReport =>
  ({
    platform: 'ios',
    slot: 'default',
    state: 'running',
    phase: 'compile',
    startedAt: ago(MIN),
    phaseStartedAt: ago(MIN / 2),
    outcome: 'cold',
    expectedMs: null,
    expectedPhaseMs: null,
    basis: 0,
    ...extra,
  }) as BuildReport;
const failed = (finishedMsAgo: number): LastBuild =>
  ({
    platform: 'ios',
    status: 'failed',
    cacheHit: false,
    cacheSkipped: false,
    durationMs: 1000,
    fingerprint: null,
    startedAt: ago(finishedMsAgo + 1000),
    finishedAt: ago(finishedMsAgo),
  }) as LastBuild;
const lease: PhysicalDeviceState = {
  platform: 'ios',
  slot: 'default',
  id: 'phone',
  name: 'iPhone',
  model: 'iPhone 17',
  owned: false,
  physical: true,
  connection: 'connected',
  lease: { holder: 'h', kind: 'declared', grantedAt: null, expiresAt: ago(-60 * MIN) },
};

describe('homeSections', () => {
  it('puts repos with live work first and live rows before idle ones, keeping the list order within each', () => {
    const sections = homeSections([
      item('alpha', 'a-idle', env('/alpha/1')),
      item('beta', 'b-idle', env('/beta/1')),
      item('beta', 'b-live', env('/beta/2', { live: true })),
      item('beta', 'b-warming', env('/beta/3', { phase: 'warming' })),
      item('gamma', 'g-live', env('/gamma/1', { live: true })),
    ]);
    expect(sections.map((s) => [s.project, s.live, s.idle, s.data.map((i) => i.title)])).toEqual([
      ['beta', 2, 1, ['b-live', 'b-warming', 'b-idle']],
      ['gamma', 1, 0, ['g-live']],
      ['alpha', 0, 1, ['a-idle']],
    ]);
  });
});

describe('checkoutProjects', () => {
  it('names only repos whose workspaces sit in different folders', () => {
    const projects = checkoutProjects([
      item('mono', 'a', env('/m/a'), 'apps/mobile'),
      item('mono', 'b', env('/m/b'), 'apps/web'),
      item('app', 'c', env('/a/c'), 'apps/mobile'),
      item('app', 'd', env('/a/d'), 'apps/mobile'),
    ]);
    expect([...projects]).toEqual(['mono']);
  });
});

describe('rowStatus', () => {
  it('reads Building while a build runs, even when an agent drives a device', () => {
    const e = env('/w', { live: true, build: build(), ios: booted(driven('agent-device', 5 * MIN)) });
    expect(rowStatus(e, NOW, null)).toMatchObject({ kind: 'building', text: 'Building iOS' });
  });

  it('reads Driven with how long the most recently started driver has driven', () => {
    const e = env('/w', {
      live: true,
      ios: booted(driven('agent-device', 30 * MIN)),
      android: { owned: true, physical: false, state: 'detected', activity: driven('maestro', 4 * MIN) },
    });
    expect(rowStatus(e, NOW, null)).toMatchObject({ kind: 'driven', text: 'Driven 4m', tone: 'brand' });
  });

  it('reads Running, not Idle, for a workspace live only through a leased phone', () => {
    const e = env('/w', { physicalDevices: [lease] });
    expect(rowStatus(e, NOW, null)).toMatchObject({ kind: 'running', tone: 'success' });
  });

  it('reads Warming with its time, Ready, and Idle with how long ago Metro stopped', () => {
    expect(rowStatus(env('/w', { phase: 'warming', phaseSince: ago(3 * MIN) }), NOW, null).text).toBe('Warming 3m');
    expect(rowStatus(env('/w', { phase: 'ready' }), NOW, null).kind).toBe('ready');
    const stopped = env('/w', {
      metro: { port: 8081, running: false, lastStop: { reason: 'stop', at: ago(45 * MIN) } },
    } as Partial<EnvironmentState>);
    expect(rowStatus(stopped, NOW, null)).toMatchObject({
      kind: 'idle',
      text: 'Idle 45m',
      label: 'Idle for 45 minutes',
    });
  });

  it('reads Last seen for a machine that is not connected, whatever the stale status says', () => {
    const e = env('/w', { live: true, build: build() });
    expect(rowStatus(e, NOW, { lastSeenAt: NOW - 3 * MIN })).toMatchObject({
      kind: 'offline',
      text: 'Last seen 3m ago',
    });
    expect(rowStatus(e, NOW, { lastSeenAt: null }).text).toBe('Offline');
  });
});

describe('rowProblems', () => {
  it('lists errors first and shows a failed build while the workspace is live', () => {
    const e = env('/w', {
      live: true,
      logs: { dir: '/l', errorsSinceMarker: 3 },
      lastBuilds: { ios: failed(3 * 24 * 60 * MIN) },
      warnings: ['w'],
    });
    expect(rowProblems(e, NOW).map((p) => [p.text, p.tone])).toEqual([
      ['3 errors', 'error'],
      ['iOS build failed', 'error'],
      ['1 warning', 'warning'],
    ]);
  });

  it('drops the failed build of an idle workspace after a day, and of a platform that is building again', () => {
    expect(rowProblems(env('/w', { lastBuilds: { ios: failed(2 * MIN) } }), NOW).map((p) => p.kind)).toEqual([
      'build-failed',
    ]);
    expect(rowProblems(env('/w', { lastBuilds: { ios: failed(25 * 60 * MIN) } }), NOW)).toEqual([]);
    const rebuilding = env('/w', { live: true, build: build(), lastBuilds: { ios: failed(2 * MIN) } });
    expect(rowProblems(rebuilding, NOW)).toEqual([]);
  });

  it('counts warnings as issues in red when one of the status issues is an error', () => {
    const e = env('/w', {
      warnings: ['a', 'b'],
      issues: [{ severity: 'error' } as NonNullable<EnvironmentState['issues']>[number]],
    });
    expect(rowProblems(e, NOW)).toEqual([{ kind: 'issues', text: '2 issues', tone: 'error' }]);
  });
});

describe('rowDevices', () => {
  it('counts running devices by kind and names each driving tool once', () => {
    const e = env('/w', {
      live: true,
      ios: booted(driven('agent-device', MIN)),
      slots: [{ slot: 'ipad', ios: booted(driven('agent-device', 2 * MIN)) }],
      physicalDevices: [lease],
    });
    expect(rowDevices(e, NOW)).toEqual({ names: '2 iOS, iOS device', drivers: 'agent-device', idle: null, remote: 0 });
  });

  it('shows idle time only when every running device has been idle for 10 minutes', () => {
    const quiet = env('/w', {
      live: true,
      ios: booted(idle(25 * MIN)),
      android: { owned: true, physical: false, state: 'detected', activity: idle(12 * MIN) },
    });
    expect(rowDevices(quiet, NOW).idle).toEqual({ text: 'idle 12m', label: 'idle for 12 minutes' });
    const recent = env('/w', {
      live: true,
      ios: booted(idle(25 * MIN)),
      android: { ...quiet.android!, activity: idle(MIN) },
    });
    expect(rowDevices(recent, NOW).idle).toBeNull();
  });
});

describe('rowLabel', () => {
  it('speaks the state, errors, build step and driven devices, and the machine only when it tells rows apart', () => {
    const e = env('/w', {
      live: true,
      build: build({ detail: { step: 'compile', unit: 'targets', done: 97, total: 214 } } as Partial<BuildReport>),
      ios: booted(driven('agent-device', 5 * MIN)),
      logs: { dir: '/l', errorsSinceMarker: 2 },
    });
    const row = item('stim', 'feat/x', e);
    const status = rowStatus(e, NOW, null);
    const problems = rowProblems(e, NOW);
    const label = (showsMachine: boolean) =>
      rowLabel({ item: row, now: NOW, status, problems, sessions: [], folder: false, showsMachine });
    expect(label(false)).toBe(
      'feat/x, Building iOS, compile, 1 minute elapsed, Cold build, 97 of 214 targets, 2 errors, iOS, driven by agent-device for 5 minutes',
    );
    expect(label(true)).toMatch(/, on Mac mini$/);
  });

  it('speaks the warming step and remote EAS sessions', () => {
    const e = env('/w', { remoteDevices: [{}, {}] } as Partial<EnvironmentState>);
    const status = rowStatus(e, NOW, null);
    const row = item('stim', 'feat/y', e);
    expect(
      rowLabel({ item: row, now: NOW, status, problems: [], sessions: [], folder: false, showsMachine: false }),
    ).toBe('feat/y, Running, 2 EAS sessions');
    const warming = env('/w', { phase: 'warming', warmStep: 'copy' });
    expect(
      rowLabel({
        item: item('stim', 'feat/y', warming),
        now: NOW,
        status: rowStatus(warming, NOW, null),
        problems: [],
        sessions: [],
        folder: false,
        showsMachine: false,
      }),
    ).toBe('feat/y, Warming, Copying ignored files');
  });
});
