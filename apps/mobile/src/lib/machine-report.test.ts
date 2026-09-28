import {
  buildStats,
  machineReport,
  parseGcReport,
  rankedOwners,
  sizeLabel,
  type GcReport,
  type InventoryDevice,
} from '@/lib/machine-report';
import type { EnvironmentState, MachineOwner, StatusPayload } from '@/protocol/types';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const GB = 1e9;
const REPO = '/Users/dev/app';
const MAIN = `${REPO}/apps/mobile`;
const FEATURE_TREE = `${REPO}/.worktrees/feature`;
const FEATURE = `${FEATURE_TREE}/apps/mobile`;
const FEATURE_WEB = `${FEATURE_TREE}/apps/web`;

function env(path: string, fields: Partial<EnvironmentState> = {}): EnvironmentState {
  return { path, live: false, memoryMb: 0, warnings: [], issues: [], ...fields } as EnvironmentState;
}

function status(environments: EnvironmentState[], fields: Partial<StatusPayload> = {}): StatusPayload {
  return {
    environments,
    capacity: { liveCount: 0, committedMb: 0, totalMemoryMb: 0, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
    ...fields,
  };
}

function device(fields: Partial<InventoryDevice> & Pick<InventoryDevice, 'id' | 'owner'>): InventoryDevice {
  return {
    kind: 'ios',
    name: fields.id,
    model: 'iPhone 18 Pro',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    lastUsedAt: null,
    bytes: null,
    project: null,
    slot: null,
    ...fields,
  };
}

const disk = (nodeModulesBytes: number) => ({
  worktreeBytes: nodeModulesBytes * 2,
  nodeModulesBytes,
  buildBytes: 1 * GB,
  measuredAt: '2026-09-28T11:00:00.000Z',
});

const feature = { path: FEATURE_TREE, branch: 'feature', repository: REPO };

const payload = status([
  env(MAIN, { disk: disk(2 * GB) }),
  env(FEATURE, {
    worktree: feature,
    disk: disk(1 * GB),
    android: { name: 'stim-feature', owned: true, physical: false, disk: { bytes: 4 * GB, measuredAt: '' } },
  }),
  env(FEATURE_WEB, { worktree: feature, disk: disk(1 * GB) }),
]);

const gc: GcReport = {
  sections: {
    workspaceBuildOutputs: [
      { dir: '/s/a', projectRoot: MAIN, bytes: 3 * GB, idleDays: 0, willClear: false },
      { dir: '/s/b', projectRoot: FEATURE, bytes: 5 * GB, idleDays: 9, willClear: true },
    ],
    workspaceLogs: [
      { projectRoot: MAIN, bytes: 0.1 * GB, trimBytes: 0, willTrim: false },
      { projectRoot: FEATURE, bytes: 0.2 * GB, trimBytes: 0.15 * GB, willTrim: true },
    ],
    linkedWorktrees: [
      {
        path: FEATURE_TREE,
        idleDays: 9,
        mergedInto: 'origin/main',
        pullRequest: null,
        willRemove: true,
        detail: 'merged',
      },
    ],
    parkedSimulators: [{ udid: 'PARKED', name: 'stim-parked', bytes: 2 * GB }],
    caches: [
      { name: 'Metro transform cache', dir: '/c/metro/app', bytes: 1 * GB, note: null },
      { name: 'Metro transform cache', dir: '/c/metro/web', bytes: 0.5 * GB, note: null },
    ],
  },
  inventory: {
    devices: [
      device({ id: 'MAIN-SIM', owner: 'workspace', project: MAIN, bytes: 6 * GB }),
      device({ id: 'stim-feature', kind: 'android', owner: 'workspace', project: FEATURE, runtime: null }),
      device({ id: 'PARKED', owner: 'parked', bytes: 2 * GB }),
      device({ id: 'MINE', owner: 'user', bytes: 7 * GB, lastUsedAt: '2026-09-26T12:00:00.000Z' }),
    ],
    runtimes: [
      {
        identifier: 'RT1',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
        version: '27.0',
        build: '24A434',
        bytes: 8 * GB,
        deviceCount: 3,
      },
      {
        identifier: 'RT2',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
        version: null,
        build: null,
        bytes: 7 * GB,
        deviceCount: 0,
      },
    ],
    systemImages: [{ package: 'system-images;android-36;google_apis;arm64-v8a', avdCount: 1 }],
    notices: [],
  },
};

describe('machineReport', () => {
  const report = machineReport(payload, gc, NOW);

  it('sizes each workspace from status and gc, and counts a worktree shared node_modules once', () => {
    const [repository] = report.repositories;
    expect(repository!.path).toBe(REPO);
    const byPath = new Map(repository!.worktrees.map((row) => [row.path, row]));
    expect(byPath.get(FEATURE)).toMatchObject({
      nodeModules: 1 * GB,
      devices: 4 * GB,
      outputs: 5 * GB,
      logs: 0.2 * GB,
      total: { bytes: 10.2 * GB, complete: true },
      lifecycle: { label: 'Merged into main', tone: 'success' },
    });
    expect(byPath.get(FEATURE_WEB)?.total).toEqual({ bytes: 1 * GB, complete: true });
    expect(byPath.get(MAIN)?.total).toEqual({ bytes: 11.1 * GB, complete: true });
    expect(repository!.total?.bytes).toBeCloseTo(21.3 * GB);
  });

  it('lists every device with its owner, taking an AVD size the gc inventory lacks from status', () => {
    expect(report.devices.map((row) => [row.name, row.owner.label, row.bytes])).toEqual([
      ['MINE', 'Yours', 7 * GB],
      ['MAIN-SIM', 'Stim \u00B7 app', 6 * GB],
      ['stim-feature', 'Stim \u00B7 feature', 4 * GB],
      ['PARKED', 'Stim \u00B7 parked', 2 * GB],
    ]);
    expect(report.devices[0]!.subtitle).toBe('iOS 27.0 \u00B7 used 2d ago');
  });

  it('lists what stim gc --delete frees, largest first, leaving caches and kept outputs out', () => {
    expect(report.free.map((row) => [row.title, row.command])).toEqual([
      ['Build outputs of feature', 'stim gc --cache workspaces'],
      ['stim-parked', 'stim gc'],
      ['Worktree feature', 'stim worktree remove'],
      ['Logs of feature', 'stim gc'],
    ]);
  });

  it('puts unused runtimes first and names caches that share a name by their folder', () => {
    expect(report.runtimes.map((row) => [row.title, row.unused])).toEqual([
      ['iOS 26.4', true],
      ['iOS 27.0', false],
      ['Android 36 \u00B7 google_apis', false],
    ]);
    expect(report.caches.map((row) => row.title)).toEqual(['Metro transform cache: app', 'Metro transform cache: web']);
  });

  it('keeps the sized devices in a workspace total whose other devices are unsized', () => {
    const partial = machineReport(
      status([env(MAIN, { disk: disk(2 * GB) })]),
      {
        sections: {},
        inventory: {
          devices: [
            device({ id: 'SIM', owner: 'workspace', project: MAIN, bytes: 6 * GB }),
            device({ id: 'AVD', kind: 'android', owner: 'workspace', project: MAIN }),
          ],
          runtimes: [],
          systemImages: [],
          notices: [],
        },
      },
      NOW,
    );
    expect(partial.repositories[0]!.worktrees[0]!.total).toEqual({ bytes: 8 * GB, complete: false });
  });

  it('marks a category with an unsized part as a lower bound', () => {
    const runtimes = report.categories.find((category) => category.key === 'runtimes');
    expect(runtimes?.total).toEqual({ bytes: 15 * GB, complete: false });
    expect(sizeLabel(runtimes!.total)).toBe('\u2265 15.0 GB');
  });

  it('shows only the Stim devices status measured when the server has no gc report', () => {
    const bare = machineReport(payload, null, NOW);
    expect(bare.inventory).toBe(false);
    expect(bare.devices.map((row) => [row.name, row.bytes])).toEqual([['stim-feature', 4 * GB]]);
    expect(bare.free).toEqual([]);
    expect(bare.categories.find((category) => category.key === 'otherDevices')?.total.complete).toBe(false);
  });

  it('reads an open pull request and a worktree stim worktree warm has not set up', () => {
    const tree = { path: `${REPO}/.worktrees/cold`, branch: 'cold', repository: REPO };
    const withPull = machineReport(
      status([env(MAIN)], {
        unprovisionedWorktrees: [
          tree,
          {
            ...tree,
            path: `${REPO}/.worktrees/review`,
            pullRequest: {
              number: 42,
              url: '',
              title: '',
              state: 'draft',
              checks: null,
              reviewDecision: null,
              checkedAt: '',
            },
          },
        ],
      }),
      null,
      NOW,
    );
    const lifecycles = withPull.repositories[0]!.worktrees.map((row) => row.lifecycle?.label ?? null);
    expect(new Set(lifecycles)).toEqual(new Set([null, 'Not warmed', 'PR #42 open']));
  });
});

describe('parseGcReport', () => {
  it('takes a gc payload and drops an inventory an older stim does not send', () => {
    expect(parseGcReport({ command: 'stats' })).toBeNull();
    expect(parseGcReport({ sections: {}, inventory: null })).toEqual({ sections: {}, inventory: null });
  });
});

describe('rankedOwners', () => {
  it('ranks by memory, then CPU', () => {
    const owner = (name: string, memoryMb: number, cpuPercent: number) =>
      ({ name, memoryMb, cpuPercent }) as MachineOwner;
    expect(rankedOwners([owner('a', 100, 5), owner('b', 900, 1), owner('c', 100, 50)]).map((o) => o.name)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('buildStats', () => {
  it('reads each platform of the stats machine section with its cache hit rate', () => {
    expect(
      buildStats({ machine: { ios: { runs: 10, failed: 1, hits: 3, misses: 1, timeSavedMs: 60_000 }, android: {} } }),
    ).toEqual([{ platform: 'ios', runs: 10, failed: 1, hitRate: 0.75, timeSavedMs: 60_000 }]);
    expect(buildStats(null)).toEqual([]);
  });
});
