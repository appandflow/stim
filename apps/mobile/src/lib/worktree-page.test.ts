import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/worktree-page-vectors.json';

import {
  buildEntries,
  worktreePage,
  worktreeApps,
  worktreeDisk,
  worktreeUsage,
  worktreeDevices,
  worktreeSessions,
} from '@/lib/worktree-page';
import type { EnvironmentState, MachineUsageState } from '@/protocol/types';

it.each(fixture.cases)('$name', ({ input, expected }) => {
  const environments = input.environments.map((app) => ({ memoryMb: 0, ...app })) as unknown as EnvironmentState[];
  const apps = worktreeApps(input.path, environments);
  const entries = buildEntries(apps);
  const { buildEntries: expectedEntries, ...expectedPage } = expected;
  expect(entries.map(({ path, platform }) => ({ path, platform }))).toEqual(expectedEntries);
  expect(worktreePage({ path: input.path, environments, entries, now: Date.parse(input.now) })).toEqual(expectedPage);
});

it('keeps native build detail tabs available independently of detected support', () => {
  const app: EnvironmentState = { path: '/w', live: false, warnings: [], memoryMb: 0, platforms: ['web'] };
  expect(buildEntries([app], true).map(({ platform }) => platform)).toEqual(['ios', 'android']);
});

it('counts shared disk once and sums independently measured app resources', () => {
  const apps: EnvironmentState[] = [
    {
      path: '/w/a',
      live: true,
      warnings: [],
      memoryMb: 80,
      disk: { worktreeBytes: 1200, nodeModulesBytes: 600, buildBytes: 100, measuredAt: 'now' },
    },
    {
      path: '/w/b',
      live: true,
      warnings: [],
      memoryMb: 20,
      disk: { worktreeBytes: 1000, nodeModulesBytes: 700, buildBytes: 200, measuredAt: 'now' },
    },
    { path: '/w/c', live: false, warnings: [], memoryMb: 0 },
  ];
  expect(worktreeUsage(apps, null)).toEqual({ cpuPercent: null, memoryMb: 100, diskBytes: 1500 });
  const owner = (workspace: string, cpuPercent: number, memoryMb: number) => ({
    kind: 'metro' as const,
    name: workspace,
    workspace,
    id: workspace,
    owned: true,
    cpuPercent,
    memoryMb,
    residentMb: memoryMb,
    processes: 1,
  });
  const machine: MachineUsageState = {
    memorySource: 'footprint',
    owners: [owner('/w/a', 130, 50), owner('/w/b', 20, 40), owner('/other', 900, 900)],
  };
  expect(worktreeUsage(apps, machine)).toEqual({ cpuPercent: 150, memoryMb: 90, diskBytes: 1500 });
  expect(worktreeDisk(apps)).toMatchObject({ worktreeBytes: 1200, nodeModulesBytes: 700, buildBytes: 300 });
  expect(worktreeUsage([apps[2]], null)).toEqual({ cpuPercent: null, memoryMb: null, diskBytes: null });
});

it('keeps device ownership after ordering and applies stopped filtering to each app', () => {
  const a: EnvironmentState = {
    path: '/w/a',
    live: false,
    warnings: [],
    memoryMb: 0,
    ios: { name: 'stopped', udid: 'stopped', owned: true, state: 'Shutdown' },
  };
  const b: EnvironmentState = {
    path: '/w/b',
    live: true,
    warnings: [],
    memoryMb: 0,
    ios: { name: 'phone', udid: 'phone', owned: true, state: 'Booted' },
    android: { name: 'pixel', owned: true, physical: false, state: 'detected' },
  };
  const c: EnvironmentState = {
    path: '/w/c',
    live: true,
    warnings: [],
    memoryMb: 0,
    ios: { name: 'tablet', udid: 'tablet', owned: true, state: 'Booted' },
  };
  expect(worktreeDevices([a, b, c], Date.now()).map(({ device, env }) => [device.id ?? device.name, env.path])).toEqual(
    [
      ['phone', '/w/b'],
      ['tablet', '/w/c'],
      ['pixel', '/w/b'],
    ],
  );
});

it('counts a session two apps share once, in the single-app order', () => {
  const session = { tool: 'codex' as const, sessionId: 'same', cwd: '/w', startedAt: '2026-10-05T10:00:00Z' };
  const apps: EnvironmentState[] = [
    {
      path: '/w/a',
      live: true,
      memoryMb: 0,
      warnings: [],
      agents: [
        { ...session, title: 'older', lastActiveAt: '2026-10-05T10:30:00Z' },
        { ...session, sessionId: 'other', lastActiveAt: '2026-10-05T11:00:00Z' },
      ],
    },
    {
      path: '/w/b',
      live: true,
      memoryMb: 0,
      warnings: [],
      agents: [{ ...session, title: 'newest', lastActiveAt: '2026-10-05T12:00:00Z' }],
    },
  ];
  expect(worktreeSessions(apps).map((agent) => [agent.sessionId, agent.title])).toEqual([
    ['other', undefined],
    ['same', 'older'],
  ]);
});
