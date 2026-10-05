import vectors from '../../../desktop/Tests/StimKitTests/Fixtures/workspace-row-vectors.json';

import type { HomeItem } from '@/lib/home';
import { checkoutProjects, homeSections, rowDevices, rowLabel, rowProblems, rowStatus } from '@/lib/home-list';
import type { BuildReport, DeviceActivity, EnvironmentState } from '@/protocol/types';

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

describe('monorepo workspace grouping', () => {
  const linked = (path: string, checkout: string, extra: Partial<EnvironmentState> = {}) =>
    env(path, { worktree: { path: checkout, repository: '/repo', branch: 'feat/shared' }, ...extra });

  it('shows a linked checkout once with each app route and counts its workspace once', () => {
    const mobile = item(
      'repo',
      'feat/shared',
      linked('/checkout/apps/mobile', '/checkout', { phase: 'ready' }),
      'apps/mobile',
    );
    const desktop = item(
      'repo',
      'feat/shared',
      linked('/checkout/apps/desktop', '/checkout', { live: true }),
      'apps/desktop',
    );
    const sections = homeSections([mobile, desktop]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ live: 1, idle: 0 });
    expect(sections[0].data).toHaveLength(1);
    expect(sections[0].data[0].apps).toEqual([desktop, mobile]);
    expect(sections[0].data[0].apps.map((app) => [app.macId, app.env.path])).toEqual([
      ['mac', '/checkout/apps/desktop'],
      ['mac', '/checkout/apps/mobile'],
    ]);
  });

  it('keeps other checkouts, machines and unknown checkout identities separate', () => {
    const first = item('repo', 'feat/shared', linked('/one/apps/mobile', '/one'), 'apps/mobile');
    const anotherCheckout = item('repo', 'feat/shared', linked('/two/apps/mobile', '/two'), 'apps/mobile');
    const anotherMac = { ...first, key: 'other\n/one/apps/mobile', macId: 'other' };
    const noIdentity = item('repo', 'feat/shared', env('/one'));
    const oldNested = item('repo', 'feat/shared', env('/one/apps/desktop'), 'apps/desktop');
    const nested = item('repo', 'feat/shared', linked('/one/nested/app', '/one/nested'), 'app');
    expect(homeSections([first, anotherCheckout, anotherMac, noIdentity, oldNested, nested])[0].data).toHaveLength(6);
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
  it('reads Last seen for a machine that is not connected, whatever the stale status says', () => {
    const e = env('/w', { live: true, build: build() });
    expect(rowStatus(e, NOW, { lastSeenAt: NOW - 3 * MIN })).toMatchObject({
      kind: 'offline',
      text: 'Last seen 3m ago',
    });
    expect(rowStatus(e, NOW, { lastSeenAt: null }).text).toBe('Offline');
  });
});

const vectorNow = Date.parse(vectors.now);

describe('workspace row vectors', () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const e = c.workspace as unknown as EnvironmentState;
    if (e.web) e.web = { ...e.web, browser: 'chrome' };
    const { kind, text, label, tone } = rowStatus(e, vectorNow, null);
    expect({ kind, text, label, tone }).toEqual(c.status);
    expect(rowProblems(e, vectorNow)).toEqual(c.problems);
    expect(rowDevices(e, vectorNow)).toEqual(c.devices);
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

  it('speaks a driven workspace once, through its devices, with their slots', () => {
    const e = env('/w', {
      live: true,
      ios: booted(driven('agent-device', 5 * MIN)),
      slots: [{ slot: 'ipad', ios: booted() }],
    });
    const row = item('stim', 'feat/z', e);
    const status = rowStatus(e, NOW, null);
    expect(
      rowLabel({ item: row, now: NOW, status, problems: [], sessions: [], folder: false, showsMachine: false }),
    ).toBe('feat/z, iOS, driven by agent-device for 5 minutes, iOS slot ipad running');
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
