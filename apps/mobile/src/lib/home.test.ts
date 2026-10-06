import fixture from '../../mock-server/fixtures/status.json';
import tones from '../../../desktop/Tests/StimKitTests/Fixtures/usage-tone-vectors.json';

import {
  budgetRows,
  DEFAULT_FILTERS,
  filterWorkspaces,
  filtersActive,
  gridRows,
  keepProjectOrder,
  machineStats,
  mergeUsageSamples,
  minFreeDiskGb,
  usageCharts,
  mergeArchives,
  mergeWorkspaces,
  mergeWorktrees,
  parseFilters,
  projectNames,
  projectsByActivity,
  runningDevices,
  visibleProjects,
  workspaceActivityMs,
  type DeviceTileItem,
} from '@/lib/home';
import type { EnvironmentState, MachineUsage, StatusPayload, UsageSample, WorktreeFacts } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  ...extra,
});
const status = (environments: EnvironmentState[], unprovisionedWorktrees?: WorktreeFacts[]): StatusPayload => ({
  ...payload,
  environments,
  unprovisionedWorktrees,
});

const macs = [
  {
    id: 'a',
    name: 'MacBook Pro',
    status: status(
      [
        env('/u/app/.worktrees/idle-one'),
        env('/u/app/.worktrees/live-one', { live: true, logs: { dir: '/l', errorsSinceMarker: 2 } }),
      ],
      [{ path: '/u/app/.worktrees/source', branch: 'source-only' }],
    ),
  },
  {
    id: 'b',
    name: 'Mac mini',
    status: status(
      [
        env('/u/app/.worktrees/building', {
          build: { ...payload.environments.find((e) => e.build)!.build!, state: 'running' },
        }),
        env('/u/other', {
          live: true,
          remoteDevices: [
            {
              platform: 'ios',
              backend: 'eas',
              sessionId: 's',
              state: 'claimed',
              startedAt: null,
              webPreviewUrl: null,
            },
          ],
        }),
      ],
      [{ path: '/u/review/.worktrees/source' }],
    ),
  },
  { id: 'c', name: 'Offline Mac', status: null },
];

describe('mergeWorkspaces', () => {
  it('lists every Mac in one list by project and name, keeping each item on its Mac', () => {
    const items = mergeWorkspaces(macs);
    expect(items.map((i) => [i.title, i.macName, i.project])).toEqual([
      ['building', 'Mac mini', 'app'],
      ['idle-one', 'MacBook Pro', 'app'],
      ['live-one', 'MacBook Pro', 'app'],
      ['other', 'Mac mini', 'other'],
    ]);
    expect(projectNames(items)).toEqual(['app', 'other']);
    const worktrees = mergeWorktrees(macs);
    expect(worktrees.map((i) => [i.title, i.macName, i.project])).toEqual([
      ['source-only', 'MacBook Pro', 'app'],
      ['source', 'Mac mini', 'review'],
    ]);
    expect(projectNames([...items, ...worktrees])).toEqual(['app', 'other', 'review']);
    const older = status([]);
    delete older.unprovisionedWorktrees;
    expect(mergeWorktrees([{ id: 'old', name: 'Old Mac', status: older }])).toEqual([]);
  });
});

describe('projectsByActivity', () => {
  const older = '2026-10-01T00:00:00Z';
  const newest = '2026-10-03T00:00:00Z';
  const activity = () => ({
    state: 'idle' as const,
    lastActivityAt: older,
    driver: { tool: 'agent-device', pid: 1, since: older },
    basis: [],
  });
  const ios = () => ({ name: 'sim', udid: 'A', owned: true, state: 'Shutdown', activity: activity() });
  const android = () => ({ name: 'emu', owned: true, physical: false, activity: activity() });
  const activityEnv = () =>
    env('/u/zeta', {
      supervisor: { pid: 1, mode: null, healthy: true, startedAt: older },
      build: {
        ...payload.environments.find((e) => e.build)!.build!,
        startedAt: older,
        phaseStartedAt: older,
      },
      phaseSince: older,
      ios: ios(),
      android: android(),
      web: { ...payload.environments.find((e) => e.web)!.web!, activity: activity() },
      slots: [{ slot: 'tablet', ios: ios(), android: android() }],
      remoteDevices: ['first', 'second'].map((sessionId) => ({
        platform: 'ios',
        backend: 'eas',
        sessionId,
        state: 'claimed',
        startedAt: older,
        webPreviewUrl: null,
      })),
      lastBuilds: {
        ios: {
          ...payload.environments.find((e) => e.lastBuilds?.ios)!.lastBuilds!.ios!,
          startedAt: older,
          finishedAt: older,
        },
        android: {
          ...payload.environments.find((e) => e.lastBuilds?.android)!.lastBuilds!.android!,
          startedAt: older,
          finishedAt: older,
        },
      },
    });

  it.each<[string, (workspace: EnvironmentState) => void]>([
    [
      'supervisor start',
      (e) => {
        e.supervisor!.startedAt = newest;
      },
    ],
    [
      'build start',
      (e) => {
        e.build!.startedAt = newest;
      },
    ],
    [
      'build phase start',
      (e) => {
        e.build!.phaseStartedAt = newest;
      },
    ],
    [
      'workspace phase',
      (e) => {
        e.phaseSince = newest;
      },
    ],
    [
      'iOS activity',
      (e) => {
        e.ios!.activity!.lastActivityAt = newest;
      },
    ],
    [
      'iOS driver',
      (e) => {
        e.ios!.activity!.driver!.since = newest;
      },
    ],
    [
      'Android activity',
      (e) => {
        e.android!.activity!.lastActivityAt = newest;
      },
    ],
    [
      'Android driver',
      (e) => {
        e.android!.activity!.driver!.since = newest;
      },
    ],
    [
      'web activity',
      (e) => {
        e.web!.activity!.lastActivityAt = newest;
      },
    ],
    [
      'web driver',
      (e) => {
        e.web!.activity!.driver!.since = newest;
      },
    ],
    [
      'slot iOS activity',
      (e) => {
        e.slots![0]!.ios!.activity!.lastActivityAt = newest;
      },
    ],
    [
      'slot iOS driver',
      (e) => {
        e.slots![0]!.ios!.activity!.driver!.since = newest;
      },
    ],
    [
      'slot Android activity',
      (e) => {
        e.slots![0]!.android!.activity!.lastActivityAt = newest;
      },
    ],
    [
      'slot Android driver',
      (e) => {
        e.slots![0]!.android!.activity!.driver!.since = newest;
      },
    ],
    [
      'remote session',
      (e) => {
        e.remoteDevices![1]!.startedAt = newest;
      },
    ],
    [
      'iOS build finish',
      (e) => {
        e.lastBuilds!.ios!.finishedAt = newest;
      },
    ],
    [
      'Android build finish',
      (e) => {
        e.lastBuilds!.android!.finishedAt = newest;
      },
    ],
    [
      'unfinished iOS build start',
      (e) => {
        e.lastBuilds!.ios!.finishedAt = null;
        e.lastBuilds!.ios!.startedAt = newest;
      },
    ],
    [
      'unfinished Android build start',
      (e) => {
        e.lastBuilds!.android!.finishedAt = null;
        e.lastBuilds!.android!.startedAt = newest;
      },
    ],
  ])('ranks the project first when %s is its newest stamp', (_source, setNewest) => {
    const workspace = activityEnv();
    setNewest(workspace);
    const items = mergeWorkspaces([
      { id: 'a', name: 'Mac', status: status([workspace, env('/u/alpha', { phaseSince: '2026-10-02T00:00:00Z' })]) },
    ]);
    expect(projectsByActivity(items)).toEqual(['zeta', 'alpha']);
  });

  it('takes the newest workspace across Macs, breaks ties by name and puts undated entries last', () => {
    const snapshots = [
      {
        id: 'a',
        name: 'Mac',
        status: status(
          [
            env('/u/zeta/.worktrees/one', { phaseSince: newest }),
            env('/u/beta', { phaseSince: older }),
            env('/u/alpha', { phaseSince: older }),
            env('/u/idle'),
          ],
          [{ path: '/u/source/.worktrees/one' }],
        ),
      },
      { id: 'b', name: 'Other Mac', status: status([env('/u/zeta/.worktrees/two', { phaseSince: older })]) },
    ];
    const archive = { ...mergeArchives([{ id: 'a', name: 'Mac', status: payload }])[0]!, project: 'archive' };
    expect(projectsByActivity([...mergeWorkspaces(snapshots), ...mergeWorktrees(snapshots), archive])).toEqual([
      'zeta',
      'alpha',
      'beta',
      'archive',
      'idle',
      'source',
    ]);
  });

  it('ignores malformed stamps and uses a completed build finish instead of its start', () => {
    const workspace = activityEnv();
    workspace.supervisor!.startedAt = 'invalid';
    workspace.phaseSince = 'invalid';
    workspace.lastBuilds!.ios!.startedAt = newest;
    expect(workspaceActivityMs(workspace)).toBe(Date.parse(older));
    expect(workspaceActivityMs(env('/u/empty', { phaseSince: null, supervisor: null }))).toBeNull();
    expect(workspaceActivityMs(env('/u/invalid', { phaseSince: 'invalid' }))).toBeNull();
  });
});

it('keeps the opening project order as activity changes, appends new names and drops removed projects', () => {
  expect(keepProjectOrder(['Gamma', 'Alpha', 'Beta'], ['Beta', 'Delta', 'Charlie', 'Gamma'])).toEqual([
    'Gamma',
    'Beta',
    'Charlie',
    'Delta',
  ]);
});

describe('visibleProjects', () => {
  const sorted = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo'];
  const options = { sorted, selected: [], query: '', expanded: false };

  it('limits collapsed projects to six by default and respects an explicit limit', () => {
    expect(visibleProjects(options)).toEqual({
      projects: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot'],
      showToggle: true,
    });
    expect(visibleProjects({ ...options, limit: 2 })).toEqual({ projects: ['Alpha', 'Beta'], showToggle: true });
  });

  it('appends selected projects beyond the limit in activity order without duplicating visible selections', () => {
    expect(visibleProjects({ ...options, selected: ['Kilo', 'Alpha', 'India', 'removed'] })).toEqual({
      projects: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'India', 'Kilo'],
      showToggle: true,
    });
  });

  it('shows every project when expanded', () => {
    expect(visibleProjects({ ...options, expanded: true })).toEqual({ projects: sorted, showToggle: true });
  });

  it.each([false, true])('searches beyond the limit and keeps selected nonmatches when expanded is %s', (expanded) => {
    expect(visibleProjects({ ...options, query: '  i  ', selected: ['Alpha', 'India'], limit: 1, expanded })).toEqual({
      projects: ['Alpha', 'India', 'Juliet', 'Kilo'],
      showToggle: false,
    });
    expect(visibleProjects({ ...options, query: 'missing' })).toEqual({ projects: [], showToggle: false });
    expect(visibleProjects({ ...options, query: 'missing', selected: ['Kilo'] })).toEqual({
      projects: ['Kilo'],
      showToggle: false,
    });
  });

  it('offers a toggle only above the limit without a trimmed query', () => {
    expect(visibleProjects({ ...options, sorted: ['Alpha', 'Beta'], limit: 2 }).showToggle).toBe(false);
    expect(visibleProjects({ ...options, sorted: [], limit: 2 }).showToggle).toBe(false);
    expect(visibleProjects({ ...options, limit: 11, expanded: true }).showToggle).toBe(false);
    expect(visibleProjects({ ...options, query: ' \t ' }).showToggle).toBe(true);
    expect(visibleProjects({ ...options, query: 'Alpha' }).showToggle).toBe(false);
  });

  it('offers no collapsed toggle when selections already show every project, but keeps Show less when expanded', () => {
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const all = { ...options, sorted: seven, selected: ['G'] };
    expect(visibleProjects(all).projects).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(visibleProjects(all).showToggle).toBe(false);
    expect(visibleProjects({ ...all, expanded: true }).showToggle).toBe(true);
  });
});

it('avoids duplicate source rows and registered checkouts without hiding a same-path worktree on another machine', () => {
  const facts = { path: '/repo/.worktrees/source', branch: 'feat/source' };
  const snapshot = status(
    [
      env('/repo/.worktrees/exact'),
      env('/repo/.worktrees/nested/apps/mobile'),
      env('/elsewhere/app', { worktree: { path: '/repo/.worktrees/linked' } }),
      env('/repo/.worktrees/source-other'),
    ],
    [
      { path: '/repo/.worktrees/exact' },
      { path: '/repo/.worktrees/nested' },
      { path: '/repo/.worktrees/linked' },
      facts,
      facts,
    ],
  );
  expect(
    mergeWorktrees([
      { id: 'a', name: 'MacBook', status: snapshot },
      { id: 'b', name: 'Mac mini', status: status([], [facts]) },
    ]).map((item) => [item.macId, item.facts.path]),
  ).toEqual([
    ['b', facts.path],
    ['a', facts.path],
  ]);
});

describe('warming and ready workspaces', () => {
  const setup = [
    {
      id: 'a',
      name: 'MacBook Pro',
      status: status([
        env('/u/app/.worktrees/idle-one'),
        env('/u/app/.worktrees/live-one', { live: true, phase: 'live' }),
        env('/u/app/.worktrees/warming', { phase: 'warming', phaseSince: '2026-09-26T10:00:00Z', warmStep: 'copy' }),
        env('/u/app/.worktrees/ready', { phase: 'ready', phaseSince: '2026-09-26T09:00:00Z' }),
        env('/u/app/.worktrees/killed', { phase: 'idle', phaseSince: null }),
      ]),
    },
  ];

  it('shows them under the live filter', () => {
    const items = mergeWorkspaces(setup);
    expect(filterWorkspaces(items, DEFAULT_FILTERS, ['a']).shown.map((i) => i.title)).toEqual([
      'live-one',
      'ready',
      'warming',
    ]);
    expect(filterWorkspaces(items, { ...DEFAULT_FILTERS, activity: 'idle' }, ['a']).shown.map((i) => i.title)).toEqual([
      'idle-one',
      'killed',
    ]);
  });
});

describe('filterWorkspaces', () => {
  const items = [...mergeWorkspaces(macs), ...mergeWorktrees(macs)];
  const ids = ['a', 'b', 'c'];
  const titles = (f: Partial<typeof DEFAULT_FILTERS>, known = ids) =>
    filterWorkspaces(items, { ...DEFAULT_FILTERS, ...f }, known).shown.map((i) => i.title);

  it('hides idle apps and source-only worktrees under Live and reveals them under Idle and All', () => {
    expect(filterWorkspaces(items, DEFAULT_FILTERS, ids)).toMatchObject({ hiddenByActivity: 3 });
    expect(titles({})).toEqual(['building', 'live-one', 'other']);
    expect(titles({ activity: 'idle' })).toEqual(['idle-one', 'source-only', 'source']);
    expect(titles({ activity: 'all' })).toEqual(['building', 'idle-one', 'live-one', 'other', 'source-only', 'source']);
  });

  it('counts the apps of one checkout as one hidden workspace', () => {
    const worktree = { path: '/u/app/.worktrees/multi', branch: 'multi' };
    const multi = [
      {
        id: 'a',
        name: 'MacBook Pro',
        status: status([
          env('/u/app/.worktrees/multi/apps/mobile', { worktree }),
          env('/u/app/.worktrees/multi/apps/desktop', { worktree }),
        ]),
      },
    ];
    expect(filterWorkspaces(mergeWorkspaces(multi), DEFAULT_FILTERS, ['a']).hiddenByActivity).toBe(1);
  });

  it('filters by Mac, project, errors and remote sessions', () => {
    expect(titles({ activity: 'all', macs: ['a'] })).toEqual(['idle-one', 'live-one', 'source-only']);
    expect(titles({ activity: 'all', projects: ['other'] })).toEqual(['other']);
    expect(titles({ activity: 'all', projects: ['review'] })).toEqual(['source']);
    expect(filterWorkspaces(items, { ...DEFAULT_FILTERS, macs: ['b'] }, ids).hiddenByActivity).toBe(1);
    expect(titles({ activity: 'all', errorsOnly: true })).toEqual(['live-one']);
    expect(titles({ activity: 'all', remoteOnly: true })).toEqual(['other']);
  });

  it('ignores a selected Mac that is no longer paired', () => {
    expect(titles({ macs: ['gone'] })).toEqual(['building', 'live-one', 'other']);
    expect(filtersActive({ ...DEFAULT_FILTERS, macs: ['gone'] }, ids, [])).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILTERS, macs: ['a'] }, ids, [])).toBe(true);
  });

  it('ignores a selected project that no machine lists any more', () => {
    expect(titles({ projects: ['removed'] })).toEqual(['building', 'live-one', 'other']);
    expect(filtersActive({ ...DEFAULT_FILTERS, projects: ['removed'] }, ids, projectNames(items))).toBe(false);
  });
});

describe('runningDevices', () => {
  it('lists the running devices of every workspace the machine and project filters keep, idle or not', () => {
    const booted = { name: 'stim-x (iPhone 18 Pro 27.0)', udid: 'A', owned: true, state: 'Booted' };
    const items = mergeWorkspaces([
      {
        id: 'a',
        name: 'MacBook Pro',
        status: status([
          env('/u/app/.worktrees/idle-with-sim', {
            ios: booted,
            android: { name: 'stim-x', owned: true, physical: false, state: 'not-detected' },
          }),
        ]),
      },
      { id: 'b', name: 'Mac mini', status: status([env('/u/other', { live: true, ios: { ...booted, udid: 'B' } })]) },
    ]);
    const keys = (f: Partial<typeof DEFAULT_FILTERS>) =>
      runningDevices(items, { ...DEFAULT_FILTERS, ...f }, ['a', 'b']).map(
        (t) => `${t.item.title}/${t.device.platform}`,
      );
    expect(keys({})).toEqual(['idle-with-sim/ios', 'other/ios']);
    expect(keys({ macs: ['a'], errorsOnly: true })).toEqual(['idle-with-sim/ios']);
    expect(keys({ projects: ['other'] })).toEqual(['other/ios']);
  });
});

describe('order across status pushes', () => {
  const sim = (udid: string, extra = {}) => ({
    name: `stim-${udid} (iPhone 18 Pro 27.0)`,
    udid,
    owned: true,
    state: 'Booted',
    ...extra,
  });
  const emulator = {
    name: 'stim-emu',
    serial: 'emulator-5554',
    owned: true,
    physical: false,
    state: 'detected' as const,
  };
  const before = [
    env('/u/app/.worktrees/zeta', { live: true, ios: sim('Z'), android: emulator }),
    env('/u/app/.worktrees/alpha', { live: true, ios: sim('A'), slots: [{ slot: 'tablet', ios: sim('T') }] }),
    env('/u/app/.worktrees/idle', { ios: sim('I') }),
  ];
  const driven = { state: 'driven' as const, driver: { tool: 'agent-device', pid: 1, since: null }, basis: [] };
  const after = [
    env('/u/app/.worktrees/zeta', {
      live: true,
      ios: sim('Z', { activity: driven }),
      android: { ...emulator, activity: driven },
      build: { ...payload.environments.find((e) => e.build)!.build!, state: 'running' },
    }),
    env('/u/app/.worktrees/alpha', {
      live: true,
      ios: sim('A', { activity: { state: 'idle', lastActivityAt: '2026-09-27T10:00:00Z', basis: [] } }),
      slots: [
        { slot: 'tablet', ios: sim('T', { activity: { ...driven, driver: { tool: 'argent', pid: 2, since: null } } }) },
      ],
    }),
    env('/u/app/.worktrees/idle', { ios: sim('I'), phase: 'warming' }),
  ];
  const listed = (environments: EnvironmentState[]) => {
    const items = mergeWorkspaces([{ id: 'a', name: 'Mac', status: status(environments) }]);
    return {
      workspaces: items.map((i) => i.title),
      tiles: runningDevices(items, DEFAULT_FILTERS, ['a']).map(
        (t) => `${t.item.title}/${t.device.slot}/${t.device.platform}`,
      ),
    };
  };

  it('does not change when only activity, drivers, builds or setup change', () => {
    expect(listed(before)).toEqual({
      workspaces: ['alpha', 'idle', 'zeta'],
      tiles: ['alpha/default/ios', 'alpha/tablet/ios', 'idle/default/ios', 'zeta/default/ios', 'zeta/default/android'],
    });
    expect(listed(after)).toEqual(listed(before));
  });

  it('keeps the others in place when a workspace or device comes or goes', () => {
    const added = [...before, env('/u/app/.worktrees/middle', { live: true, ios: sim('M') })];
    expect(listed(added).tiles).toEqual([
      'alpha/default/ios',
      'alpha/tablet/ios',
      'idle/default/ios',
      'middle/default/ios',
      'zeta/default/ios',
      'zeta/default/android',
    ]);
    const stopped = before.map((e) => (e.path.endsWith('alpha') ? { ...e, slots: [] } : e));
    expect(listed(stopped).tiles).toEqual(listed(before).tiles.filter((t) => t !== 'alpha/tablet/ios'));
  });
});

describe('gridRows', () => {
  it('pairs portrait tiles in order and gives a landscape tile its own row', () => {
    const tiles = ['a', 'b', 'c', 'ipad', 'd', 'e'].map((key) => ({ key }) as DeviceTileItem);
    const rows = gridRows(
      tiles,
      new Map([
        ['ipad', 1.45],
        ['b', 0.46],
      ]),
    );
    expect(rows.map((row) => row.map((tile) => tile.key))).toEqual([['a', 'b'], ['c'], ['ipad'], ['d', 'e']]);
  });
});

describe('parseFilters', () => {
  it('keeps valid saved filters and falls back to defaults for anything else', () => {
    expect(parseFilters(JSON.stringify({ macs: ['a', 3], activity: 'all', errorsOnly: true }))).toEqual({
      ...DEFAULT_FILTERS,
      macs: ['a'],
      activity: 'all',
      errorsOnly: true,
    });
    expect(parseFilters('{not json')).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(JSON.stringify({ activity: 'sometimes' })).activity).toBe('live');
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS);
  });
});

describe('machineStats', () => {
  const usage = (
    memory: Partial<MachineUsage['memory']>,
    cpuUsage: number | null,
    ...free: number[]
  ): MachineUsage => ({
    volumes: free.map((freeBytes, i) => ({ mount: `/v${i}`, holds: [], freeBytes, totalBytes: 1e12 })),
    memory: { totalBytes: 48 * 2 ** 30, usedBytes: 23.4 * 2 ** 30, pressure: 'normal', ...memory },
    load: { avg1: 1, avg5: 1, avg15: 1, cpus: 8 },
    cpu: { usage: cpuUsage, cores: 8 },
    sampledAt: '2026-09-25T00:00:00.000Z',
  });

  it('reads CPU busy fraction, memory used and the lowest free space, and warns below their thresholds', () => {
    expect(machineStats(usage({}, 0.34, 212e9, 500e9))).toEqual([
      { kind: 'cpu', label: 'CPU', value: '34%', tone: 'normal' },
      { kind: 'memory', label: 'RAM', value: '23/48 GB', tone: 'normal' },
      { kind: 'disk', label: 'Disk', value: '212 GB free', tone: 'normal' },
    ]);
    expect(machineStats(usage({}, 0.85, 212e9)).find((s) => s.kind === 'cpu')?.tone).toBe('warn');
    expect(machineStats(usage({}, 0.99, 212e9)).find((s) => s.kind === 'cpu')?.tone).toBe('critical');
    expect(machineStats(usage({}, 0.34, 14e9)).find((s) => s.kind === 'disk')?.tone).toBe('warn');
    expect(machineStats(usage({}, 0.34, 2e9)).find((s) => s.kind === 'disk')?.tone).toBe('critical');
    expect(machineStats(null)).toEqual([]);
  });

  it('steps tones where Stim Desktop steps them', () => {
    const toneOf = (kind: 'cpu' | 'disk' | 'memory', stats: MachineUsage) => {
      const tone = machineStats(stats).find((s) => s.kind === kind)?.tone;
      return tone === 'warn' ? 'caution' : tone === 'critical' ? 'error' : tone;
    };
    expect(tones.cpu.map((c) => toneOf('cpu', usage({}, c.fraction, 500e9)))).toEqual(tones.cpu.map((c) => c.tone));
    expect(tones.disk.map((c) => toneOf('disk', usage({}, 0.1, c.freeBytes)))).toEqual(tones.disk.map((c) => c.tone));
    expect(
      tones.memory.map((c) =>
        toneOf('memory', usage({ pressure: c.pressure as MachineUsage['memory']['pressure'] }, 0.1, 500e9)),
      ),
    ).toEqual(tones.memory.map((c) => c.tone));
  });

  it('colors by memory pressure, and leaves a stat out when the server does not report it', () => {
    expect(machineStats(usage({ pressure: 'warning' }, 0.1, 212e9)).find((s) => s.kind === 'memory')?.tone).toBe(
      'warn',
    );
    expect(machineStats(usage({ pressure: 'critical' }, 0.1, 14e9)).find((s) => s.kind === 'memory')?.tone).toBe(
      'critical',
    );
    const older = usage({}, null, 212e9);
    delete (older.memory as Partial<MachineUsage['memory']>).usedBytes;
    expect(machineStats(older).map((s) => s.kind)).toEqual(['disk']);
  });

  it('leaves CPU out for a server older than the cpu field, instead of crashing', () => {
    const older = usage({}, 0.5, 212e9);
    delete (older as Partial<MachineUsage>).cpu;
    expect(machineStats(older).map((s) => s.kind)).toEqual(['memory', 'disk']);
  });
});

describe('budgetRows', () => {
  it('describes the budget settings stim settings --json reports', () => {
    const settings = {
      settings: [
        { key: 'budget.minFreeDiskGb', value: 20 },
        { key: 'budget.hardFloorDiskGb', value: 0 },
        { key: 'budget.maxCommittedMemoryGb', value: null },
        { key: 'budget.maxLiveWorkspaces', value: 4 },
        { key: 'ios.runtime', value: null },
      ],
    };
    expect(budgetRows(settings)).toEqual([
      { label: 'Reclaims disk', value: 'below 20 GB free' },
      { label: 'Refuses to run', value: 'never' },
      { label: 'Memory budget', value: '60% of memory' },
      { label: 'Live workspaces', value: '4' },
    ]);
    expect(budgetRows({ settings: 'nope' })).toEqual([]);
  });
});

describe('minFreeDiskGb', () => {
  const setting = (value: unknown) => ({ settings: [{ key: 'budget.minFreeDiskGb', value }] });

  it('reads the positive floor the Mac reports', () => {
    expect(minFreeDiskGb(setting(20))).toBe(20);
  });

  it('is null for no floor, a missing entry or a malformed payload', () => {
    expect(minFreeDiskGb(setting(0))).toBeNull();
    expect(minFreeDiskGb(setting(-5))).toBeNull();
    expect(minFreeDiskGb(setting(null))).toBeNull();
    expect(minFreeDiskGb(setting('20'))).toBeNull();
    expect(minFreeDiskGb({ settings: [{ key: 'ios.runtime', value: 18 }, null, 'x'] })).toBeNull();
    expect(minFreeDiskGb({ settings: 'nope' })).toBeNull();
    expect(minFreeDiskGb(null)).toBeNull();
  });
});

describe('mergeUsageSamples', () => {
  const sample = (at: number): UsageSample => ({
    at,
    cpu: 1,
    memoryUsedBytes: null,
    memoryPressure: null,
    diskFreeBytes: null,
  });
  const ats = (samples: UsageSample[]) => samples.map((s) => s.at);
  const HOUR = 60 * 60 * 1000;

  it('keeps only the samples newer than the last one held when windows overlap', () => {
    const merged = mergeUsageSamples([sample(1000), sample(2000)], [sample(1500), sample(2000), sample(3000)]);
    expect(ats(merged)).toEqual([1000, 2000, 3000]);
  });

  it('starts from an empty history', () => {
    expect(ats(mergeUsageSamples([], [sample(5), sample(6)]))).toEqual([5, 6]);
    expect(mergeUsageSamples([], [])).toEqual([]);
  });

  it('drops samples that fall out of the history window', () => {
    const start = 10 * HOUR;
    const merged = mergeUsageSamples([sample(start), sample(start + 1000)], [sample(start + HOUR + 500)]);
    expect(ats(merged)).toEqual([start + 1000, start + HOUR + 500]);
  });
});

describe('usageCharts', () => {
  const MIN = 60_000;
  const END = 1_800_000_000_000;
  const usage: MachineUsage = {
    volumes: [{ mount: '/', holds: [], freeBytes: 100e9, totalBytes: 1000e9 }],
    memory: { totalBytes: 64 * 2 ** 30, usedBytes: 32 * 2 ** 30, pressure: 'normal' },
    load: { avg1: 1, avg5: 1, avg15: 1, cpus: 8 },
    cpu: { usage: 0.2, cores: 8 },
    sampledAt: '2026-09-25T00:00:00.000Z',
  };
  const sample = (at: number, cpu: number | null, memoryPressure = 0, diskFreeBytes = 100e9) => ({
    at,
    cpu,
    memoryUsedBytes: 32 * 2 ** 30,
    memoryPressure,
    diskFreeBytes,
  });

  it('averages each minute of the hour ending at the newest sample, leaving empty minutes null', () => {
    const [cpu] = usageCharts(
      [
        sample(END - 61 * MIN, 0.9),
        sample(END - 30 * MIN - 10, 0.2),
        sample(END - 30 * MIN - 20, 0.4),
        sample(END, 0.1),
      ],
      usage,
    );
    expect(cpu!.columns).toHaveLength(60);
    expect(cpu!.columns.filter(Boolean)).toHaveLength(2);
    expect(cpu!.columns[29]!.fraction).toBeCloseTo(0.3);
    expect(cpu!.columns[59]).toEqual({ fraction: 0.1, tone: 'normal' });
    expect(cpu!.columns[0]).toBeNull();
    expect(cpu!.value).toBe('10%');
  });

  it('takes the worst tone in a column and the newest sample for the headline', () => {
    const [cpu, memory, disk] = usageCharts(
      [sample(END - 10_000, 0.99, 2, 4e9), sample(END - 5000, 0.1, 0, 15e9), sample(END, null, 1, 15e9)],
      usage,
    );
    expect(cpu!.columns[59]!.tone).toBe('critical');
    expect(cpu).toMatchObject({ value: '10%', tone: 'normal' });
    expect(memory).toMatchObject({ kind: 'memory', value: '32/64 GB', tone: 'warn' });
    expect(memory!.columns[59]).toEqual({ fraction: 0.5, tone: 'critical' });
    expect(disk).toMatchObject({ kind: 'disk', value: '15 GB', tone: 'warn' });
    expect(disk!.columns[59]!.fraction).toBeCloseTo(34e9 / 3 / 1000e9);
  });

  it('draws nothing without samples or the totals it scales by', () => {
    expect(usageCharts([], usage)).toEqual([]);
    expect(usageCharts([sample(END, 0.5)], null)).toEqual([]);
    expect(usageCharts([sample(END, 0.5)], { ...usage, volumes: [] }).map((c) => c.kind)).toEqual(['cpu', 'memory']);
  });
});

test('renders unknown live and numeric history memory pressure without an alarm tone', () => {
  const usage: MachineUsage = {
    volumes: [],
    memory: { totalBytes: 1024, usedBytes: 100, pressure: 'future-kind' },
    load: { avg1: 0, avg5: 0, avg15: 0, cpus: 4 },
    sampledAt: '2026-09-27T12:00:00Z',
  };
  expect(machineStats(usage).find((stat) => stat.kind === 'memory')?.tone).toBe('normal');
  expect(
    usageCharts([{ at: 1, cpu: null, memoryUsedBytes: 100, memoryPressure: 99, diskFreeBytes: null }], usage).find(
      (chart) => chart.kind === 'memory',
    )?.tone,
  ).toBe('normal');
});

it('round-trips Archived with the persisted machine and project filters', () => {
  const selected = { ...DEFAULT_FILTERS, activity: 'archived' as const, macs: ['a'], projects: ['stim'] };
  expect(parseFilters(JSON.stringify(selected))).toEqual(selected);
  expect(filtersActive(selected, ['a'], ['stim'])).toBe(true);
});

it('keeps archives out of Live, Idle and All and their hidden-idle counts', () => {
  const archives = mergeArchives([{ id: 'a', name: 'Mac', status: payload }]);
  const live = mergeWorkspaces(macs);
  const entries = [...live, ...mergeWorktrees(macs), ...archives];
  for (const activity of ['live', 'idle', 'all'] as const) {
    const filtered = filterWorkspaces(entries, { ...DEFAULT_FILTERS, activity }, ['a', 'b']);
    expect(filtered.shown.some((entry) => 'archive' in entry)).toBe(false);
    expect(filtered.hiddenByActivity).toBe(
      filterWorkspaces(
        entries.filter((entry) => !('archive' in entry)),
        { ...DEFAULT_FILTERS, activity },
        ['a', 'b'],
      ).hiddenByActivity,
    );
  }
  expect(filterWorkspaces(entries, { ...DEFAULT_FILTERS, activity: 'archived' }, ['a', 'b']).shown).toEqual(archives);
  expect(
    filterWorkspaces(entries, { ...DEFAULT_FILTERS, activity: 'archived', projects: ['tlon-apps'] }, [
      'a',
      'b',
    ]).shown.map((entry) => entry.project),
  ).toEqual(['tlon-apps']);
  expect(mergeArchives([{ id: 'old', name: 'Old server', status: { ...status([]), archived: undefined } }])).toEqual(
    [],
  );
});
