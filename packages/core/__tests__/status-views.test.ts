import { needsAttention, oversee, type OversightEnvironment } from '../oversight.ts';
import { applyKeyedDelta, KeyedEntities, statusViews, type StatusPayload } from '../state/index.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const long = (label: string, length: number) => `${label}-${'x'.repeat(Math.max(0, length - label.length - 1))}`;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();

function device(i: number) {
  return {
    name: long(`stim-env-${i} (iPhone 17 Pro Max 27.1)`, 48),
    udid: `AAAAAAAA-0000-4000-8000-${String(i).padStart(12, '0')}`,
    owned: true,
    state: 'Booted',
    activity: {
      state: 'driven',
      lastActivityAt: at(1),
      basis: 'agent-actions',
      driver: { tool: 'agent-device', pid: 4242, since: at(0) },
    },
    app: { id: long('com.example.workspace', 48), state: 'running' },
    appPresence: 'open',
  };
}

function build(platform: string, n: number, failed = true) {
  return {
    platform,
    status: failed ? 'failed' : 'ok',
    cacheHit: false,
    cacheSkipped: false,
    durationMs: 120_000,
    fingerprint: long('fingerprint', 40),
    startedAt: at(n),
    finishedAt: at(n + 2),
    errorCode: 'STIM_BUILD_FAILED',
    diagnostics: [{ file: long('ios/App/AppDelegate', 60), line: 120, message: long('cannot find type', 120) }],
    missReason: {
      kind: 'changed',
      summary: long('native dependency changed', 80),
      changes: Array.from({ length: 5 }, (_, k) => ({
        source: long(`node_modules/package-${k}`, 60),
        change: 'modified',
        category: 'native-dependency',
      })),
      changeCount: 5,
      baseline: { fingerprint: long('baseline', 40), from: at(0) },
      rekeyedBy: [],
    },
    result: failed ? 'failed' : 'succeeded',
    slot: 'default',
    configuration: 'Debug',
    cacheKey: long('cache-key', 64),
    phases: { prepare: 400, 'cache-lookup': 300, prebuild: 9000, compile: 90_000, install: 2000, launch: 3000 },
  };
}

/** An environment with every optional section present, each at the size the largest real ones reach. */
function environment(i: number) {
  const path = long(`/Users/someone/Developer/project/.worktrees/feature-${i}/apps/mobile`, 96);
  return {
    path,
    live: true,
    phase: 'live',
    phaseSince: null,
    stage: { kind: 'running', since: at(0), platform: 'ios', closedApps: [] },
    platforms: ['ios', 'android', 'web'],
    memoryMb: 4096,
    memorySource: 'footprint',
    warnings: [long('Slot tablet records both a local and hosted iOS simulator', 140)],
    issues: Array.from({ length: 3 }, (_, k) => ({
      code: `issue-${k}`,
      severity: 'warning',
      message: long('simulator is booted without Metro', 100),
      remedy: 'stim start',
    })),
    ios: device(i),
    android: {
      name: `stim-env-${i}`,
      owned: true,
      physical: false,
      serial: 'emulator-5554',
      state: 'detected',
      appPresence: 'open',
    },
    slots: [{ slot: 'tablet', ios: device(i + 1000), android: null }],
    metro: {
      port: 8100 + i,
      running: true,
      pid: 5000 + i,
      bundle: { bundling: false, last: { platform: 'ios', status: 'ok', durationMs: 1800, finishedAt: at(3) } },
    },
    supervisor: { pid: 6000 + i, mode: 'expo', startedAt: at(0), healthy: true },
    agentDevice: { stateDir: long(`/Users/someone/.stim/workspaces/feature-${i}/agent-device`, 90), installed: true },
    logs: { dir: long(`/Users/someone/.stim/workspaces/feature-${i}/logs`, 80), errorsSinceMarker: 3 },
    worktree: {
      path,
      branch: long(`feature/${i}-make-the-status-feed-realtime`, 60),
      repository: '/Users/someone/Developer/project',
      git: { changed: 4, untracked: 2, upstream: 'origin/feature', ahead: 1, behind: 0, mergedInto: null },
      gitChip: { parts: [{ kind: 'changed', count: 4 }], ci: null },
      pullRequest: {
        number: 3000 + i,
        url: `https://github.com/example/project/pull/${3000 + i}`,
        title: long('feat: make the status feed realtime', 90),
        state: 'open',
        checks: { passing: 12, failing: 0, pending: 2 },
        reviewDecision: null,
        checkedAt: at(2),
      },
    },
    build: {
      platform: 'ios',
      slot: 'default',
      state: 'running',
      phase: 'compile',
      startedAt: at(4),
      phaseStartedAt: at(5),
      outcome: 'cold',
      outcomeKnown: true,
      expectedMs: 180_000,
      expectedPhaseMs: 90_000,
      basis: 'history',
      plannedPhases: [
        { phase: 'prepare', expectedMs: 400 },
        { phase: 'compile', expectedMs: 90_000 },
        { phase: 'install', expectedMs: 2000 },
      ],
      detail: { unit: 'targets', done: 120, total: 300 },
    },
    lastBuilds: { ios: build('ios', 1), android: build('android', 2) },
    builds: {
      ios: Array.from({ length: 10 }, (_, n) => build('ios', n)),
      android: Array.from({ length: 10 }, (_, n) => build('android', n)),
      macos: Array.from({ length: 10 }, (_, n) => build('macos', n)),
    },
    macos: {
      launchId: '1debfc4b-c626-44ce-a5f0-369e3eae7057',
      arguments: Array.from({ length: 12 }, (_, k) => long(`-argument.${k}`, 40)),
      product: 'StimDesktop',
      bundle: long('/Users/someone/.stim/workspaces/feature/macos/StimDesktop.app', 100),
      bundleId: long('dev.stim.desktop.development', 50),
      executable: long('/Users/someone/.stim/workspaces/feature/macos/StimDesktop.app/Contents/MacOS/StimDesktop', 120),
      build: { state: 'ok', startedAt: at(0), finishedAt: at(1), durationMs: 7731 },
      state: 'running',
    },
    disk: { worktreeBytes: 1e9, nodeModulesBytes: 2e9, buildBytes: 3e9, measuredAt: at(0) },
    agents: Array.from({ length: 3 }, (_, k) => ({
      tool: 'claude-code',
      sessionId: `019caf56-0021-464e-8c3a-${String(k).padStart(12, '0')}`,
      cwd: path,
      title: long('Make the status feed realtime and keep the payload small', 90),
      startedAt: at(0),
      lastActiveAt: at(5),
      pid: 7000 + k,
      openUrl: long('claude://resume?session=019caf56-0021-464e-8c3a', 80),
    })),
    endedAgents: Array.from({ length: 5 }, (_, k) => ({
      tool: 'codex',
      sessionId: `thread-${k}`,
      cwd: path,
      title: long('An earlier session', 90),
      endedAt: at(k),
    })),
    remoteDevices: [{ sessionId: 'eas-1', platform: 'ios', backend: 'eas', state: 'running', startedAt: at(0) }],
    recording: { enabled: true },
    doctorRuns: { ios: { at: at(0) }, android: { at: at(0) } },
  };
}

function worktree(i: number) {
  return {
    path: long(`/Users/someone/Developer/project/.worktrees/unprovisioned-${i}`, 90),
    branch: long(`fix/${i}-something-small`, 50),
    repository: '/Users/someone/Developer/project',
    git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: null },
    gitChip: { parts: [{ kind: 'no-upstream' }], ci: null },
    pullRequest: {
      number: 4000 + i,
      url: `https://github.com/example/project/pull/${4000 + i}`,
      title: long('fix: something small', 90),
      state: 'merged',
      checks: null,
      reviewDecision: null,
      checkedAt: at(0),
    },
  };
}

function archive(i: number) {
  return {
    id: `feature-${i}--05842230738c3ea9--17908559${String(i).padStart(5, '0')}`,
    projectRoot: long(`/Users/someone/Developer/project/.worktrees/old-${i}/apps/mobile`, 96),
    project: 'mobile',
    workspace: `mobile--05842230738c3ea9`,
    worktree: { repository: '/Users/someone/Developer/project', branch: `old/${i}`, head: null, subject: null },
    removedAt: at(i % 60),
    removedBy: 'worktree-remove',
    builds: { count: 10, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 100_000, recordings: 0, agentActions: 1000, record: 2000, total: 103_000 },
    expires: {},
    version: 1,
  };
}

/** An environment as most of a busy home's are: idle, with a worktree, a pull request and a build history. */
function idle(i: number) {
  const { path, worktree: facts, disk, stage, platforms, logs } = environment(i);
  return {
    path,
    live: false,
    phase: 'idle',
    phaseSince: null,
    stage: { ...stage, kind: 'idle' },
    platforms,
    memoryMb: 0,
    memorySource: 'estimate',
    warnings: [],
    issues: [],
    ios: { name: null, udid: device(i).udid, owned: true, state: 'Shutdown', appPresence: null },
    metro: { port: 8100 + i, running: false, pid: null, lastStop: { reason: 'idle', at: at(0), idleMinutes: 30 } },
    supervisor: null,
    logs,
    worktree: facts,
    build: null,
    lastBuilds: { ios: build('ios', 0, false) },
    builds: { ios: Array.from({ length: 10 }, (_, n) => build('ios', n, false)) },
    disk,
  };
}

function payload(busy: number, quiet: number, worktrees: number, archives: number): StatusPayload {
  const value: StatusPayload = JSON.parse(
    JSON.stringify({
      environments: [
        ...Array.from({ length: busy }, (_, i) => environment(i)),
        ...Array.from({ length: quiet }, (_, i) => idle(busy + i)),
      ],
      archived: Array.from({ length: archives }, (_, i) => archive(i)),
      archivedUsage: {
        count: archives,
        bytes: archives * 103_000,
        byKind: { logs: 0, recordings: 0, agentActions: 0, record: 0 },
      },
      capacity: { liveCount: busy, committedMb: 4096 * busy, totalMemoryMb: 65_536, overCapacity: false },
      deviceLeases: [],
      unprovisionedWorktrees: Array.from({ length: worktrees }, (_, i) => worktree(i)),
      simctlAvailable: true,
      machine: null,
      maintenance: {
        mode: 'on',
        lastChecks: { pressure: 1, size: 1, worktree: 1, sweep: 1 },
        pressure: null,
        sizes: Array.from({ length: 20 }, (_, k) => ({ name: long(`cache-${k}`, 40), bytes: 1e9 })),
        lastPass: null,
        running: null,
        recent: Array.from({ length: 20 }, (_, k) => ({ ts: k, msg: long('Removed an orphaned workspace', 200) })),
        plan: [],
      },
    }),
  );
  return value;
}

describe('status live views stay within their size budget', () => {
  const busy = 10;
  const quiet = 60;
  const worktrees = 100;
  const views = statusViews(payload(busy, quiet, worktrees, 200));

  test('a summary is at most 32 KB with every section at its largest and every build failing, and 3 KB for an idle workspace', () => {
    expect(bytes(views.workspaces[0])).toBeLessThanOrEqual(32 * 1024);
    expect(bytes(views.workspaces[busy])).toBeLessThanOrEqual(3 * 1024);
  });

  test('the workspace list snapshot', () => {
    const list = { workspaces: views.workspaces, worktrees: views.worktrees, archived: views.archived };
    expect(bytes(list)).toBeLessThanOrEqual(8 * 1024 + busy * 32 * 1024 + quiet * 3 * 1024 + worktrees * 384);
  });

  test('a list update carries only the workspace that changed', () => {
    const entities = new KeyedEntities<{ path: string }>((entity) => entity.path);
    entities.reset(views.workspaces);
    const changed = views.workspaces.map((workspace, i) => (i === busy ? { ...workspace, memoryMb: 1 } : workspace));
    const delta = entities.next(changed);
    expect(delta?.upsert).toHaveLength(1);
    expect(delta?.remove).toEqual([]);
    expect(bytes(delta)).toBeLessThanOrEqual(3 * 1024 + 64);
  });

  test('a workspace detail and the machine view', () => {
    expect(Math.max(...[...views.details.values()].map(bytes))).toBeLessThanOrEqual(64 * 1024);
    expect(bytes(views.machine)).toBeLessThanOrEqual(4 * 1024);
  });
});

test('needs-attention and oversight find the same items in a summary as in the full environment', () => {
  const views = statusViews(payload(10, 5, 0, 0));
  const full: OversightEnvironment[] = [...views.details.values()];
  const summaries: OversightEnvironment[] = views.workspaces;
  const now = Date.parse(at(30));
  const attention = (environments: OversightEnvironment[]) =>
    needsAttention({ environments, volumes: null, now, stuckMinutes: 15, easSessionMinutes: 30 });
  expect(attention(full).some((item) => item.category === 'looping')).toBe(true);
  expect(attention(summaries)).toEqual(attention(full));
  const notifications = (environments: OversightEnvironment[]) =>
    oversee(
      null,
      {
        machine: 'mac',
        status: { environments },
        volumes: null,
        memoryPressure: null,
        link: null,
        pullRequests: {},
        ownLeases: [],
      },
      {
        categories: ['started', 'stuck', 'looping', 'finished', 'machine', 'attention'],
        stuckMinutes: 15,
        quiet: false,
      },
      now,
    );
  expect(notifications(summaries)).toEqual(notifications(full));
});

test('applying each delta to the first snapshot rebuilds the latest list, including after a resync', () => {
  type Row = { path: string; n: number };
  const key = (row: Row) => row.path;
  const sender = new KeyedEntities<Row>(key);
  let rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ path: `/w/${i}`, n: 0 }));
  sender.reset(rows);
  let client = rows;
  let seed = 7;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let step = 0; step < 200; step++) {
    const roll = random(3);
    if (roll === 0) rows = rows.map((row) => (random(2) ? { ...row, n: row.n + 1 } : row));
    else if (roll === 1) rows = [...rows, { path: `/w/new-${step}`, n: 0 }];
    else rows = rows.filter((_, i) => i !== random(rows.length + 1));
    const delta = sender.next(rows);
    if (step === 120) {
      sender.reset(rows);
      client = rows;
      continue;
    }
    if (delta) client = applyKeyedDelta(client, delta, key);
    expect(new Map(client.map((row) => [row.path, row]))).toEqual(new Map(rows.map((row) => [row.path, row])));
  }
});
