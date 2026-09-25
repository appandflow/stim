import fixture from '../../mock-server/fixtures/status.json';

import {
  budgetRows,
  DEFAULT_FILTERS,
  filterWorkspaces,
  filtersActive,
  gridRows,
  macUsageSummary,
  mergeWorkspaces,
  parseFilters,
  projectNames,
  runningDevices,
  type DeviceTileItem,
} from '@/lib/home';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

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
  it('lists every Mac in one list: building, then live, then idle, keeping each item on its Mac', () => {
    const items = mergeWorkspaces(macs);
    expect(items.map((i) => [i.title, i.macName, i.project])).toEqual([
      ['building', 'Mac mini', 'app'],
      ['live-one', 'MacBook Pro', 'app'],
      ['other', 'Mac mini', 'other'],
      ['idle-one', 'MacBook Pro', 'app'],
    ]);
    expect(projectNames(items)).toEqual(['app', 'other']);
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
    expect(titles({ activity: 'all', macs: ['a'] })).toEqual(['live-one', 'idle-one']);
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
    expect(keys({})).toEqual(['other/ios', 'idle-with-sim/ios']);
    expect(keys({ macs: ['a'], errorsOnly: true })).toEqual(['idle-with-sim/ios']);
    expect(keys({ projects: ['other'] })).toEqual(['other/ios']);
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

describe('macUsageSummary', () => {
  const usage = (memory: Partial<MachineUsage['memory']>, ...free: number[]): MachineUsage => ({
    volumes: free.map((freeBytes, i) => ({ mount: `/v${i}`, holds: [], freeBytes, totalBytes: 1e12 })),
    memory: { totalBytes: 48 * 2 ** 30, usedBytes: 23.4 * 2 ** 30, pressure: 'normal', ...memory },
    load: { avg1: 1, avg5: 1, avg15: 1, cpus: 8 },
    sampledAt: '2026-09-25T00:00:00.000Z',
  });
  const capacity = { liveCount: 0, committedMb: 0, totalMemoryMb: 49152, overCapacity: false };

  it("reads live workspaces, the Mac's memory used and the lowest free space, and warns below 20 GB", () => {
    expect(macUsageSummary({ ...payload, capacity }, usage({}, 212e9, 500e9))).toEqual({
      parts: ['0 live', '23.4/48 GB', '212 GB free'],
      tone: 'normal',
    });
    expect(macUsageSummary({ ...payload, capacity }, usage({}, 14e9)).tone).toBe('warn');
    expect(macUsageSummary({ ...payload, capacity }, null)).toEqual({ parts: ['0 live'], tone: 'normal' });
  });

  it('colors by memory pressure, and leaves memory out when the server does not report it', () => {
    expect(macUsageSummary(null, usage({ pressure: 'warning' }, 212e9)).tone).toBe('warn');
    expect(macUsageSummary(null, usage({ pressure: 'critical' }, 14e9)).tone).toBe('critical');
    const older = usage({}, 212e9);
    delete (older.memory as Partial<MachineUsage['memory']>).usedBytes;
    expect(macUsageSummary(null, older).parts).toEqual(['212 GB free']);
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
