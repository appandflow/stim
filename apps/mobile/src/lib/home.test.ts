import fixture from '../../mock-server/fixtures/status.json';
import tones from '../../../desktop/Tests/StimKitTests/Fixtures/usage-tone-vectors.json';

import {
  budgetRows,
  DEFAULT_FILTERS,
  filterWorkspaces,
  filtersActive,
  gridRows,
  machineStats,
  mergeUsageSamples,
  minFreeDiskGb,
  usageCharts,
  mergeWorkspaces,
  parseFilters,
  projectNames,
  runningDevices,
  usageTone,
  type DeviceTileItem,
  type UsageTone,
} from '@/lib/home';
import type { EnvironmentState, MachineUsage, StatusPayload, UsageSample } from '@/protocol/types';

const payload = fixture.payload as StatusPayload;
const env = (path: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path,
  live: false,
  memoryMb: 0,
  warnings: [],
  ...extra,
});
const status = (environments: EnvironmentState[]): StatusPayload => ({ ...payload, environments });

const macs = [
  {
    id: 'a',
    name: 'MacBook Pro',
    status: status([
      env('/u/app/.worktrees/idle-one'),
      env('/u/app/.worktrees/live-one', { live: true, logs: { dir: '/l', errorsSinceMarker: 2 } }),
    ]),
  },
  {
    id: 'b',
    name: 'Mac mini',
    status: status([
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
    ]),
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
  });
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
  const items = mergeWorkspaces(macs);
  const ids = ['a', 'b', 'c'];
  const titles = (f: Partial<typeof DEFAULT_FILTERS>, known = ids) =>
    filterWorkspaces(items, { ...DEFAULT_FILTERS, ...f }, known).shown.map((i) => i.title);

  it('hides idle workspaces by default and counts them', () => {
    expect(filterWorkspaces(items, DEFAULT_FILTERS, ids)).toMatchObject({ hiddenByActivity: 1 });
    expect(titles({})).toEqual(['building', 'live-one', 'other']);
    expect(titles({ activity: 'idle' })).toEqual(['idle-one']);
  });

  it('filters by Mac, project, errors and remote sessions', () => {
    expect(titles({ activity: 'all', macs: ['a'] })).toEqual(['idle-one', 'live-one']);
    expect(titles({ activity: 'all', projects: ['other'] })).toEqual(['other']);
    expect(titles({ errorsOnly: true })).toEqual(['live-one']);
    expect(titles({ remoteOnly: true })).toEqual(['other']);
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

describe('usageTone', () => {
  it('draws normal in the text color and warn and critical as the warning and error colors', () => {
    expect((['normal', 'warn', 'critical'] as UsageTone[]).map(usageTone)).toEqual(['default', 'warning', 'error']);
  });
});
