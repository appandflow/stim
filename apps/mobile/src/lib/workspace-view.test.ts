import vectors from '../../../desktop/Tests/StimKitTests/Fixtures/workspace-view-vectors.json';

import { activityBadge } from '@/lib/format';
import { devicesOf } from '@/lib/workspaces';
import {
  agentRow,
  appPresence,
  checksSummary,
  phaseName,
  barSteps,
  barFills,
  buildLine,
  bundleLine,
  currentPhaseLabel,
  deviceTitle,
  deviceUsage,
  fallbackLine,
  diskParts,
  diskPartsLabel,
  gitChip,
  localGitChipFacts,
  localStageFacts,
  namesPhases,
  phaseSteps,
  type PhaseStep,
  processRows,
  usageLabel,
  usageParts,
  remoteBuild,
  workspaceSeries,
  workspaceStage,
  workspaceUsage,
} from '@/lib/workspace-view';
import type {
  BuildHistoryEntry,
  DeviceActivity,
  BuildReport,
  EnvironmentState,
  GitChipFacts,
  LastBuild,
  MachineUsageState,
  StageFacts,
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

  it('takes the presence stim reports once it reports the stage', () => {
    const stage: StageFacts = { kind: 'running', since: null, platform: null, closedApps: [] };
    const reported = env({ ios: { ...stopped, appPresence: 'none' }, stage });
    expect(appPresence(reported, devicesOf(reported)[0]!)).toBe('none');
    const cleared = env({ ios: { ...stopped, appPresence: null }, stage });
    expect(appPresence(cleared, devicesOf(cleared)[0]!)).toBeNull();
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

describe('barFills state', () => {
  const current = (fraction: number): PhaseStep => ({
    phase: 'compile',
    state: 'current',
    elapsedMs: null,
    expectedMs: 1000,
    fraction,
  });

  it('remembers progress within a build without carrying it into another build', () => {
    const first = barFills([current(0.8)], 'prune-progress')[0]!;
    expect(barFills([current(0.2)], 'prune-progress')[0]).toBeGreaterThanOrEqual(first);
    expect(barFills([current(0.2)], 'prune-other-build')[0]).toBeLessThan(first);
  });

  it('does not credit a pending phase with remembered progress', () => {
    barFills([current(0.8)], 'prune-pending');
    expect(barFills([{ ...current(0), state: 'pending' }], 'prune-pending')[0]).toBe(0);
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

type VectorStep = PhaseStep & { name: string };

const vectorNow = Date.parse(vectors.now);
const steady = (steps: readonly PhaseStep[]) =>
  steps.map((step) => ({
    phase: step.phase,
    name: phaseName(step.phase),
    state: step.state,
    elapsedMs: step.elapsedMs,
    expectedMs: step.expectedMs,
    fraction: step.fraction === null ? null : Number(step.fraction.toFixed(9)),
  }));
const expectedSteps = (steps: VectorStep[]) =>
  steps.map((step) => ({ ...step, fraction: step.fraction === null ? null : Number(step.fraction.toFixed(9)) }));

describe('workspace view vectors', () => {
  it.each(vectors.stage.map((c) => [c.name, c] as const))('stage: %s', (_, c) => {
    const e = c.workspace as unknown as EnvironmentState;
    const derived = c.derived as StageFacts;
    expect(localStageFacts(e, devicesOf(e))).toEqual(derived);
    for (const env of [e, { ...e, stage: derived }]) {
      const stage = workspaceStage(env, devicesOf(env), vectorNow);
      expect(stage.kind).toBe(c.derived.kind);
      expect({ label: stage.label, tone: stage.tone, subtitle: stage.subtitle }).toEqual(c.stage);
    }
  });

  it.each(vectors.gitChip.map((c) => [c.name, c] as const))('git chip: %s', (_, c) => {
    const worktree = c.worktree as unknown as WorktreeFacts;
    const derived = c.derived as GitChipFacts;
    expect(localGitChipFacts(worktree.git!, worktree.pullRequest)).toEqual(derived);
    const toneOf = (tone: string) => (tone === 'default' ? 'normal' : tone === 'secondary' ? 'neutral' : tone);
    for (const facts of [worktree, { ...worktree, gitChip: derived }]) {
      const chip = gitChip(facts);
      const pr = chip?.pr ? { text: chip.pr.text, tone: chip.pr.tone, checks: chip.pr.ci } : null;
      expect({
        parts: chip?.parts.map((p) => ({ text: p.text, tone: toneOf(p.tone) })),
        pullRequest: pr,
        label: chip?.label,
      }).toEqual(c.chip);
    }
  });

  it('decides the stage itself when stim reports a kind this app does not know', () => {
    const e = {
      ...(vectors.stage[0]!.workspace as unknown as EnvironmentState),
      stage: { kind: 'paused', since: null, platform: null, closedApps: [] } as unknown as StageFacts,
    };
    expect(workspaceStage(e, devicesOf(e), vectorNow).subtitle).toBe(vectors.stage[0]!.stage.subtitle);
  });

  it.each(vectors.appPresence.map((c) => [c.name, c] as const))('app presence: %s', (_, c) => {
    const e = c.workspace as unknown as EnvironmentState;
    const device = devicesOf(e).find((d) => d.platform === c.platform && d.slot === c.slot)!;
    expect(appPresence(e, device)).toBe(c.presence);
  });

  it.each(vectors.checksSummary.map((c) => [c.name, c] as const))('checks summary: %s', (_, c) => {
    expect(checksSummary(c.checks)).toBe(c.summary);
  });

  it.each(vectors.phases.map((c) => [c.name, c] as const))('phases: %s', (_, c) => {
    const steps = phaseSteps(c.build as unknown as BuildReport, c.history as unknown as BuildHistoryEntry[], vectorNow);
    expect(steady(steps)).toEqual(expectedSteps(c.steps as VectorStep[]));
    expect(steady(barSteps(steps)).map((s) => ({ ...s, elapsedMs: null }))).toEqual(
      expectedSteps(c.bars as VectorStep[]),
    );
    expect(namesPhases(steps)).toBe(c.namesPhases);
  });

  it.each(vectors.activity.badge.map((c) => [c.name, c] as const))('activity badge: %s', (_, c) => {
    expect(activityBadge(c.activity as unknown as DeviceActivity, vectorNow)?.text ?? null).toBe(c.text);
  });

  it.each(vectors.bundleLine.map((c) => [c.name, c] as const))('bundle line: %s', (_, c) => {
    const line = bundleLine(c.workspace as unknown as EnvironmentState, vectorNow, c.reportsBundles);
    expect(line && { text: line.text, tone: line.tone === 'default' ? 'normal' : line.tone }).toEqual(c.line);
  });

  it.each(vectors.diskParts.map((c) => [c.name, c] as const))('disk parts: %s', (_, c) => {
    expect(diskParts(c.workspace as unknown as EnvironmentState)).toEqual(c.parts);
  });

  it.each(vectors.agentRow.map((c) => [c.name, c] as const))('agent row: %s', (_, c) => {
    const last = c.last && { ts: vectorNow - c.last.agoMs, msg: c.last.message };
    expect(agentRow(c.activity as unknown as DeviceActivity, last, vectorNow)).toEqual(c.row);
  });
});

describe('usageParts and usageLabel', () => {
  it('words the disk parts in one line and sums them to the workspace disk', () => {
    const e = env({
      disk: { worktreeBytes: 1.72e9, nodeModulesBytes: 1.53e9, buildBytes: 19.2e6, measuredAt: iso(0) },
    });
    const parts = diskParts(e)!;
    expect(diskPartsLabel(parts)).toBe('node_modules 1.5 GB, Rest of worktree 190 MB, Build output 19 MB');
    expect(parts.reduce((sum, part) => sum + part.bytes, 0)).toBeCloseTo(workspaceUsage(e, null).diskBytes!);
  });

  it('lists the measured resources in CPU, memory, disk order', () => {
    const usage = { cpuPercent: 42.4, memoryMb: 2048, diskBytes: 3e9 };
    expect(usageParts(usage).map((part) => [part.kind, part.value])).toEqual([
      ['cpu', '42%'],
      ['memory', '2.0 GB'],
      ['disk', '3.0 GB'],
    ]);
    expect(usageLabel(usage)).toBe('CPU 42%, memory 2.0 GB, disk 3.0 GB');
  });

  it('leaves out a resource that is not measured, but keeps a measured zero', () => {
    expect(usageLabel({ cpuPercent: null, memoryMb: 512, diskBytes: null })).toBe('memory 512 MB');
    expect(usageLabel({ cpuPercent: 0, memoryMb: null, diskBytes: null })).toBe('CPU 0%');
    expect(usageLabel({ cpuPercent: null, memoryMb: null, diskBytes: null })).toBe('');
  });
});
