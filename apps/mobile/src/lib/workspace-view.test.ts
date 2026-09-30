import { devicesOf } from '@/lib/workspaces';
import {
  agentRow,
  appPresence,
  barFills,
  barSteps,
  buildLine,
  bundleLine,
  currentPhaseLabel,
  deviceTitle,
  deviceUsage,
  fallbackLine,
  gitChip,
  namesPhases,
  phaseSteps,
  type PhaseStep,
  processRows,
  remoteBuild,
  workspaceSeries,
  workspaceStage,
  workspaceUsage,
} from '@/lib/workspace-view';
import type {
  BuildHistoryEntry,
  BuildReport,
  EnvironmentState,
  LastBuild,
  MachineUsageState,
  PullRequestFacts,
  WorktreeFacts,
} from '@/protocol/types';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

const env = (patch: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path: '/w',
  live: true,
  phase: 'live',
  memoryMb: 0,
  warnings: [],
  ...patch,
});

const build = (patch: Partial<BuildReport> = {}): BuildReport => ({
  platform: 'ios',
  slot: 'default',
  state: 'running',
  phase: 'compile',
  startedAt: iso(72_000),
  phaseStartedAt: iso(47_000),
  outcome: 'cold',
  expectedMs: 160_000,
  expectedPhaseMs: 94_000,
  basis: 3,
  ...patch,
});

const last = (patch: Partial<LastBuild> = {}): LastBuild => ({
  platform: 'ios',
  status: 'ok',
  cacheHit: 'local',
  cacheSkipped: false,
  durationMs: 33_000,
  fingerprint: null,
  startedAt: iso(27 * MIN),
  finishedAt: iso(26 * MIN),
  ...patch,
});

const booted = { name: 'stim-w (iPhone 18 27.0)', udid: 'SIM-1', owned: true, state: 'Booted' };

describe('workspaceStage', () => {
  it('names each stage the workspace screen shows, with its subtitle', () => {
    const stage = (e: EnvironmentState) => workspaceStage(e, devicesOf(e), NOW);
    expect(stage(env({ supervisor: { pid: 1, mode: null, startedAt: iso(42 * MIN), healthy: true } }))).toEqual({
      kind: 'running',
      label: 'Running',
      tone: 'success',
      subtitle: 'up 42m',
    });
    expect(stage(env({ build: build() }))).toEqual({
      kind: 'building',
      label: 'Building',
      tone: 'brand',
      subtitle: 'iOS \u00B7 started 1m ago',
    });
    expect(stage(env({ lastBuilds: { ios: last({ status: 'failed', finishedAt: iso(3 * MIN) }) } }))).toMatchObject({
      kind: 'build-failed',
      label: 'Build failed',
      tone: 'error',
      subtitle: 'iOS \u00B7 3m ago',
    });
    expect(stage(env({ live: false, phase: 'warming', warmStep: 'refresh', phaseSince: iso(2 * MIN) }))).toMatchObject({
      kind: 'warming',
      label: 'Warming',
      subtitle: 'installing dependencies \u00B7 2m',
    });
    expect(
      stage(
        env({
          live: false,
          phase: 'idle',
          metro: { port: 8084, running: false, pid: null, lastStop: { reason: 'idle', at: iso(120 * MIN) } },
        }),
      ),
    ).toEqual({ kind: 'stopped', label: 'Stopped', tone: 'tertiary', subtitle: '2h ago' });
  });

  it('turns a running workspace red for log errors or an app that closed', () => {
    const crashed = env({
      logs: { dir: '', errorsSinceMarker: 3 },
      ios: { ...booted, app: { id: 'a', state: 'stopped' } },
    });
    expect(workspaceStage(crashed, devicesOf(crashed), NOW)).toEqual({
      kind: 'running',
      label: 'Running',
      tone: 'error',
      subtitle: '3 errors \u00B7 iOS app closed',
    });
  });

  it('reports the newest build of either platform, so an older failure does not mask a newer success', () => {
    const e = env({
      lastBuilds: {
        ios: last({ status: 'failed', startedAt: iso(60 * MIN) }),
        android: last({ platform: 'android', startedAt: iso(5 * MIN) }),
      },
    });
    expect(workspaceStage(e, [], NOW).label).toBe('Running');
  });
});

describe('appPresence', () => {
  const failed = last({ status: 'failed' });
  const entry = (result: BuildHistoryEntry['result']): BuildHistoryEntry => ({
    ...last(),
    result,
    slot: 'default',
    configuration: 'Debug',
    cacheKey: null,
    phases: {},
  });
  const stopped = { ...booted, app: { id: 'a', state: 'stopped' as const } };
  const presence = (patch: Partial<EnvironmentState>) => {
    const e = env(patch);
    return appPresence(e, devicesOf(e)[0]!);
  };

  it('never reports the app of a leased phone, which Stim does not track', () => {
    const e = env({ ios: booted, lastBuilds: { ios: failed }, builds: { ios: [entry('failed')] } });
    expect(appPresence(e, devicesOf(e)[0]!)).toBe('none');
    expect(appPresence(e, { ...devicesOf(e)[0]!, physical: true, owned: false })).toBeNull();
  });

  it('says no app only when the latest build failed and none ever succeeded', () => {
    expect(presence({ ios: stopped, lastBuilds: { ios: failed }, builds: { ios: [entry('failed')] } })).toBe('none');
    expect(
      presence({ ios: stopped, lastBuilds: { ios: failed }, builds: { ios: [entry('failed'), entry('succeeded')] } }),
    ).toBe('closed');
  });

  it('does not guess from a missing app, which status leaves out when it does not know the bundle id', () => {
    expect(presence({ ios: booted, lastBuilds: { ios: failed } })).toBeNull();
  });
});

describe('usage from machine owners', () => {
  const machine: MachineUsageState = {
    memorySource: 'footprint',
    owners: [
      {
        kind: 'simulator',
        name: 's',
        workspace: '/w',
        id: 'SIM-1',
        owned: true,
        cpuPercent: 9,
        residentMb: 3000,
        memoryMb: 2150,
        processes: 40,
      },
      {
        kind: 'emulator',
        name: 'e',
        workspace: '/w',
        id: 'stim-w',
        owned: true,
        cpuPercent: 14,
        residentMb: 3000,
        memoryMb: 2970,
        processes: 3,
      },
      {
        kind: 'metro',
        name: 'm',
        workspace: '/w',
        id: '8084',
        owned: true,
        cpuPercent: 250,
        residentMb: 1500,
        memoryMb: 1434,
        processes: 2,
      },
      {
        kind: 'emulator',
        name: 'x',
        workspace: '/other',
        id: 'stim-x',
        owned: true,
        cpuPercent: 99,
        residentMb: 1,
        memoryMb: 1,
        processes: 1,
      },
    ],
  };
  const e = env({
    ios: booted,
    android: { name: 'stim-w', owned: true, physical: false, serial: 'emulator-5554', state: 'detected' },
  });

  it('sums the workspace owners, past 100% on several cores', () => {
    expect(workspaceUsage(e, machine)).toEqual({ cpuPercent: 273, memoryMb: 6554, diskBytes: null });
  });

  it('matches an emulator by slot and kind, since its owner id is the AVD name and not the serial', () => {
    const android = devicesOf(e).find((d) => d.platform === 'android')!;
    expect(android.id).toBe('emulator-5554');
    expect(deviceUsage(android, '/w', machine, 5.1e9)).toEqual({ cpuPercent: 14, memoryMb: 2970, diskBytes: 5.1e9 });
  });

  it("gives a leased phone none of its slot's simulator usage", () => {
    const phone = { ...devicesOf(e).find((d) => d.platform === 'ios')!, physical: true, owned: false };
    expect(deviceUsage(phone, '/w', machine, null)).toBeNull();
  });

  it('lists devices before Metro in the process table', () => {
    expect(processRows(e, devicesOf(e), machine).map((row) => row.label)).toEqual([
      'iPhone 18 simulator',
      'Android emulator',
      'Metro',
    ]);
  });

  it('adds the worktree and build folders for the workspace disk', () => {
    const disk = { worktreeBytes: 1.9e9, nodeModulesBytes: 0.9e9, buildBytes: 0.3e9, measuredAt: iso(0) };
    expect(workspaceUsage(env({ disk }), null).diskBytes).toBeCloseTo(2.2e9);
  });
});

describe('deviceTitle', () => {
  it('splits an owned simulator model into the model and its iOS runtime', () => {
    const [ios] = devicesOf(env({ ios: booted }));
    expect(deviceTitle(ios!)).toEqual({ name: 'iPhone 18', detail: 'iOS 27.0' });
    const [other] = devicesOf(
      env({ slots: [{ slot: 'tablet', ios: { ...booted, name: 'stim-w (iPad Pro 13-inch (M5) 26.2)' } }] }),
    );
    expect(deviceTitle(other!)).toEqual({ name: 'iPad Pro 13-inch (M5)', detail: 'iOS 26.2 \u00B7 tablet' });
  });

  it('titles a leased iPhone by its own name and model, not as a simulator', () => {
    const phone = { platform: 'ios', slot: 'default', physical: true, running: true, owned: false } as const;
    expect(deviceTitle({ ...phone, id: 'U', name: 'Old iPhone', model: 'iPhone 12 Pro', state: 'connected' })).toEqual({
      name: 'Old iPhone',
      detail: 'iPhone 12 Pro',
    });
    expect(deviceTitle({ ...phone, id: 'U', name: 'iOS device', model: 'iOS device', state: 'connected' })).toEqual({
      name: 'iOS device',
      detail: '',
    });
  });
});

describe('buildLine', () => {
  it('shows a run as its time and hit status, a failure as Failed, and else the next build prediction', () => {
    expect(buildLine('ios', last(), undefined)).toMatchObject({
      main: '0:33',
      sub: 'hit',
      tone: 'default',
      spoken: 'iOS last build 0:33, hit',
    });
    expect(buildLine('ios', last({ cacheHit: false, durationMs: 158_000 }), undefined)).toMatchObject({
      main: '2:38',
      sub: 'cold',
    });
    expect(buildLine('ios', last({ status: 'failed' }), undefined)).toMatchObject({ main: 'Failed', tone: 'error' });
    expect(
      buildLine('ios', last({ cacheHit: false, durationMs: 70_000, offloadedTo: 'janics-mac-mini:7869' }), undefined),
    ).toMatchObject({ main: '1:10', sub: 'on janics-mac-mini', spoken: 'iOS last build 1:10, on janics-mac-mini' });
    const plan = {
      kind: 'done' as const,
      plan: {
        platform: 'ios' as const,
        fingerprint: 'f',
        cacheKey: null,
        cacheHit: 'local' as const,
        provider: null,
        cacheSkipped: false,
        prebuild: null,
        outcome: 'hit' as const,
        expectedMs: 39_000,
        basis: 2,
      },
    };
    expect(buildLine('ios', undefined, plan)).toMatchObject({
      main: '~0:39',
      sub: 'est.',
      tone: 'secondary',
      spoken: 'iOS next build about 0:39, hit',
    });
    expect(buildLine('ios', undefined, { kind: 'checking' })).toMatchObject({ main: 'Checking\u2026' });
    expect(buildLine('ios', undefined, { kind: 'failed', message: 'x' })).toMatchObject({ main: 'No build' });
  });
});

describe('offloaded builds', () => {
  const remote = { host: 'janics-mac-mini:7869', phase: 'pods', startedAt: iso(90_000), phaseStartedAt: iso(56_000) };

  it('names the build machine without its port and the step it runs there, with that step elapsed', () => {
    expect(remoteBuild(build({ phase: 'pods', placement: remote }), NOW)).toEqual({
      host: 'janics-mac-mini',
      phase: 'Pods',
      phaseElapsedMs: 56_000,
    });
    expect(currentPhaseLabel(build({ phase: 'prepare', placement: { ...remote, phase: 'sync' } })).phase).toBe('Sync');
    expect(currentPhaseLabel(build({ phase: 'compile', placement: { ...remote, phase: 'build' } })).phase).toBe(
      'Compile',
    );
    expect(remoteBuild(build({ placement: 'local' }), NOW)).toBeNull();
    expect(remoteBuild(build(), NOW)).toBeNull();
  });

  it('shortens the fallback reasons stim records to the first machine and why', () => {
    const cases: [string, string][] = [
      [
        'janics-mac-mini: busy (load at or above 2/core; load 8.2/core, 2 builds)',
        'janics-mac-mini busy \u2192 built here',
      ],
      [
        'mini:7869: Stim build 6bbe there, e774 here; busy (already running 1 offloaded build(s), its limit)',
        'mini on another Stim build \u2192 built here',
      ],
      [
        'mini: no less loaded (load 1.2/core there, 0.4/core here); box: no offer',
        'mini no less loaded \u2192 built here',
      ],
      ['mini: capacity unknown (older stim-server) while this Mac has a free slot', 'mini too old \u2192 built here'],
      ['mini: no iPhone simulator on 27.0 there', 'mini missing SDK \u2192 built here'],
      ['mini: 4.1 GB free, needs 10.0 GB', 'mini low on disk \u2192 built here'],
      [
        'mini: Stim build 6bbe there, e774 here; 4.1 GB free, needs 10.0 GB',
        'mini on another Stim build \u2192 built here',
      ],
      ['mini: the connection closed (1006)', 'mini failed \u2192 built here'],
      ['this app is not in a git checkout (fatal: not a git repository)', 'offload skipped \u2192 built here'],
    ];
    for (const [reason, text] of cases) expect(fallbackLine({ offloadFallback: reason })).toEqual({ text, reason });
    expect(fallbackLine({})).toBeNull();
  });
});

describe('phaseSteps', () => {
  const history: BuildHistoryEntry[] = [
    {
      ...last({ cacheHit: false }),
      result: 'succeeded',
      slot: 'default',
      configuration: 'Debug',
      cacheKey: null,
      phases: { prepare: 2000, prebuild: 4000, pods: 21_000, compile: 94_000, install: 8000 },
    },
  ];

  it('marks earlier phases done and later ones pending, with the reference run times as estimates', () => {
    const steps = phaseSteps(build(), history, NOW);
    expect(steps.map((s) => [s.phase, s.state])).toEqual([
      ['prepare', 'done'],
      ['prebuild', 'done'],
      ['pods', 'done'],
      ['compile', 'current'],
      ['install', 'pending'],
    ]);
    expect(steps[3]).toMatchObject({ elapsedMs: 47_000, fraction: 0.5 });
    expect(steps[4]).toMatchObject({ expectedMs: 8000 });
  });

  it('folds the short prepare phases into one bar segment and launch into install', () => {
    const steps = phaseSteps(build({ phase: 'cache-lookup', phaseStartedAt: iso(0) }), history, NOW);
    expect(barSteps(steps).map((s) => [s.phase, s.state])).toEqual([
      ['prepare', 'current'],
      ['prebuild', 'pending'],
      ['pods', 'pending'],
      ['compile', 'pending'],
      ['install', 'pending'],
    ]);
  });

  it('gives the device wait its own bar segment between the build and install', () => {
    const hit: BuildHistoryEntry = {
      ...history[0]!,
      cacheHit: 'local',
      phases: { prepare: 1000, device: 500, 'cache-lookup': 3000, install: 2000, launch: 1000 },
    };
    const steps = phaseSteps(
      build({ outcome: 'hit', phase: 'device', phaseStartedAt: iso(0), expectedPhaseMs: null }),
      [hit],
      NOW,
    );
    expect(barSteps(steps).map((s) => [s.phase, s.state])).toEqual([
      ['prepare', 'done'],
      ['device', 'current'],
      ['install', 'pending'],
    ]);
  });

  it('names phases only when there is more than one, so a first build in a fresh workspace does not repeat its stage', () => {
    const fresh = phaseSteps(build({ phase: 'prepare', phaseStartedAt: iso(0) }), [], NOW);
    expect(fresh.map((s) => s.phase)).toEqual(['prepare']);
    expect(namesPhases(fresh)).toBe(false);
    expect(namesPhases(barSteps(fresh))).toBe(false);
    expect(namesPhases(phaseSteps(build(), history, NOW))).toBe(true);
  });

  it('moves the compile phase by the build tool counts only when they are ahead of the time estimate', () => {
    const detail = {
      step: 'compile' as const,
      unit: 'targets' as const,
      done: 45,
      total: 180,
      line: null,
      updatedAt: iso(0),
    };
    expect(phaseSteps(build({ detail }), history, NOW)[3]!.fraction).toBe(0.5);
    expect(phaseSteps(build({ detail: { ...detail, done: 135 } }), history, NOW)[3]!.fraction).toBe(0.75);
    expect(phaseSteps(build({ detail: { ...detail, done: 0 } }), history, NOW)[3]!.fraction).toBe(0.5);
    expect(currentPhaseLabel(build({ detail }))).toEqual({ phase: 'Compiling', counts: '45 of 180 targets' });
    expect(currentPhaseLabel(build({ detail: { ...detail, unit: 'tasks', total: null } })).counts).toBe('45 tasks');
    expect(currentPhaseLabel(build({ phase: 'install', detail: { ...detail, step: 'sign' } }))).toEqual({
      phase: 'Install',
      counts: null,
    });
  });

  it("draws the CLI's planned phases instead of the workspace history when the CLI sends them", () => {
    const planned = build({
      phase: 'cache-lookup',
      phaseStartedAt: iso(1000),
      outcome: 'hit',
      expectedPhaseMs: 2000,
      plannedPhases: [
        { phase: 'prepare', expectedMs: 1500 },
        { phase: 'cache-lookup', expectedMs: 2000 },
        { phase: 'device', expectedMs: 800 },
        { phase: 'install', expectedMs: 500 },
        { phase: 'launch', expectedMs: 9000 },
      ],
    });
    expect(barSteps(phaseSteps(planned, [], NOW)).map((s) => [s.phase, s.state])).toEqual([
      ['prepare', 'current'],
      ['device', 'pending'],
      ['install', 'pending'],
    ]);
    expect(phaseSteps(planned, history, NOW).map((s) => s.phase)).toEqual([
      'prepare',
      'cache-lookup',
      'device',
      'install',
      'launch',
    ]);
  });
});

describe('barFills', () => {
  const step = (phase: PhaseStep['phase'], state: PhaseStep['state'], expectedMs: number, fraction: number) => ({
    phase,
    state,
    elapsedMs: null,
    expectedMs,
    fraction,
  });

  it('fills done segments, part of the current one and none of the pending ones', () => {
    const fills = barFills(
      [step('prepare', 'done', 4000, 1), step('compile', 'current', 8000, 0.5), step('install', 'pending', 8000, 0)],
      'fills-plain',
    );
    expect(fills).toEqual([1, 0.5, 0]);
    expect(barFills([], 'fills-empty')).toEqual([]);
  });

  it('never fills a pending segment when no phase is current', () => {
    const key = 'fills-no-current';
    barFills([step('prepare', 'done', 4000, 1), step('install', 'current', 6000, 0.9)], key);
    expect(barFills([step('prepare', 'done', 4000, 1), step('install', 'pending', 6000, 0)], key)).toEqual([1, 0]);
  });

  it('keeps what it drew for the same build when the plan changes, up to the end of the current segment', () => {
    const key = 'fills-replan';
    const round = (fills: number[]) => fills.map((fill) => Math.round(fill * 100) / 100);
    expect(barFills([step('prepare', 'current', 4000, 0.9), step('install', 'pending', 6000, 0)], key)).toEqual([
      0.9, 0,
    ]);
    expect(round(barFills([step('prepare', 'current', 4000, 0.2), step('install', 'pending', 6000, 0)], key))).toEqual([
      0.9, 0,
    ]);
    const coldPlan = [
      step('prepare', 'done', 4000, 1),
      step('pods', 'current', 10_000, 0.02),
      step('compile', 'pending', 60_000, 0),
      step('install', 'pending', 6000, 0),
    ];
    expect(round(barFills(coldPlan, key))).toEqual([1, 0.95, 0, 0]);
    expect(barFills(coldPlan, 'fills-other-build')[1]).toBeCloseTo(0.02, 5);
  });
});

describe('bundleLine', () => {
  const metro = (bundle?: NonNullable<EnvironmentState['metro']>['bundle']) =>
    env({ metro: { port: 8084, running: true, pid: 1, ...(bundle ? { bundle } : {}) } });

  it('shows bundling with its percent, the last bundle, or that none ran yet', () => {
    expect(bundleLine(metro({ bundling: true, percent: 62.4 }), NOW, true)?.text).toBe('Bundling \u00B7 62%');
    expect(
      bundleLine(
        metro({ bundling: false, last: { platform: 'ios', status: 'ok', durationMs: 1800, finishedAt: iso(12_000) } }),
        NOW,
        true,
      )?.text,
    ).toBe('Bundled in 1.8s');
    expect(bundleLine(metro(), NOW, true)?.text).toBe('Not bundled yet');
  });

  it('keeps the "ago" suffix on a failed bundle', () => {
    expect(
      bundleLine(
        metro({
          bundling: false,
          last: { platform: 'ios', status: 'failed', durationMs: 1800, finishedAt: iso(12_000) },
        }),
        NOW,
        true,
      )?.text,
    ).toBe('Bundle failed \u00B7 12s ago');
  });

  it('leaves the line out for a server that reports no bundles', () => {
    expect(bundleLine(metro(), NOW, false)).toBeNull();
  });
});

describe('agentRow', () => {
  it('names the driving tool with its last action, or how long the device has been quiet', () => {
    const driven = {
      state: 'driven' as const,
      driver: { tool: 'agent-device', pid: 1, since: iso(18 * MIN) },
      basis: [],
    };
    expect(agentRow(driven, { ts: NOW - 12_000, msg: 'Tapped "Allow camera"' }, NOW)).toEqual({
      tool: 'agent-device',
      text: 'Tapped "Allow camera" \u00B7 12s ago',
    });
    expect(agentRow({ state: 'idle', lastActivityAt: iso(6 * MIN), basis: [] }, null, NOW)).toEqual({
      tool: null,
      text: 'idle 6m',
    });
  });
});

describe('gitChip', () => {
  const worktree = (
    git: Partial<NonNullable<WorktreeFacts['git']>>,
    patch: Partial<WorktreeFacts> = {},
  ): WorktreeFacts => ({
    path: '/w',
    git: { changed: 0, untracked: 0, upstream: 'origin/x', ahead: 0, behind: 0, mergedInto: null, ...git },
    ...patch,
  });

  it('shows only the non-zero git details, a merge, or a missing upstream', () => {
    expect(gitChip(worktree({ ahead: 2, changed: 2, untracked: 1 }))?.parts.map((p) => p.text)).toEqual([
      '\u21912',
      '3 changed',
    ]);
    expect(gitChip(worktree({ mergedInto: 'main' }))?.parts.map((p) => p.text)).toEqual(['merged into main']);
    expect(gitChip(worktree({ upstream: null, ahead: null, behind: null }))?.parts.map((p) => p.text)).toEqual([
      'no upstream',
    ]);
    expect(gitChip(worktree({}))).toEqual({ parts: [], pr: null, label: 'Branch, up to date' });
    expect(gitChip({ path: '/w' })).toBeNull();
  });

  it('colors the pull request by state with one CI mark for the worst check, and spells it out', () => {
    const pullRequest: PullRequestFacts = {
      number: 1695,
      url: 'https://github.com/o/r/pull/1695',
      title: 't',
      state: 'open',
      checks: { passing: 12, failing: 1, pending: 2 },
      reviewDecision: null,
      checkedAt: iso(0),
    };
    const chip = (patch: Partial<PullRequestFacts>, git = {}) =>
      gitChip(worktree(git, { pullRequest: { ...pullRequest, ...patch } }));
    expect(chip({})?.pr).toEqual({ text: 'PR #1695', tone: 'success', ci: 'failing' });
    expect(chip({ checks: { passing: 12, failing: 0, pending: 2 } })?.pr?.ci).toBe('pending');
    expect(chip({ checks: { passing: 12, failing: 0, pending: 0 } })).toEqual({
      parts: [],
      pr: { text: 'PR #1695', tone: 'success', ci: 'passing' },
      label: 'Pull request 1695, open, checks passing',
    });
    expect(chip({ state: 'draft', checks: null })?.pr).toEqual({ text: 'PR #1695', tone: 'tertiary', ci: null });
    const merged = chip({ state: 'merged', checks: null }, { mergedInto: 'main' });
    expect(merged).toMatchObject({ parts: [], pr: { tone: 'brand' } });
    expect(chip({ state: 'closed' }, { ahead: 2, changed: 1 })).toEqual({
      parts: [
        { text: '\u21912', tone: 'default' },
        { text: '1 changed', tone: 'secondary' },
      ],
      pr: { text: 'PR #1695', tone: 'error', ci: 'failing' },
      label: 'Pull request 1695, closed, checks failing, 1 uncommitted change, 2 commits not pushed',
    });
  });
});

describe('workspaceSeries', () => {
  it('reads the workspace series with its window, peak CPU and memory change, skipping empty slots', () => {
    const usage = {
      intervalMs: 15_000,
      endAt: NOW,
      environments: [{ workspace: '/w', cpuPercent: [null, 40, 188, 38], memoryMb: [null, 7500, 7900, 8000] }],
      devices: [],
    };
    expect(workspaceSeries(usage, '/w')).toMatchObject({ minutes: 1, peakCpuPercent: 188, memoryChangeMb: 500 });
    expect(workspaceSeries(usage, '/other')).toBeNull();
  });
});
