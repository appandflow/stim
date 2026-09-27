import {
  inQuietHours,
  OVERSIGHT_CATEGORIES,
  oversee,
  type OversightEnvironment,
  type OversightInput,
  type OversightNotification,
  type OversightPrefs,
  type OversightState,
} from '../src/oversight.ts';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const MIN = 60_000;
const PATH = '/u/app/.worktrees/wide-insets';
const iso = (at: number) => new Date(at).toISOString();

type Env = OversightEnvironment;
type Build = NonNullable<NonNullable<Env['builds']>['ios']>[number];

const sim = (activity: { state: string; tool?: string; since?: number; lastAt?: number } | null, state = 'Booted') => ({
  name: 'stim-wide (iPhone 18 Pro 27.0)',
  state,
  ...(activity
    ? {
        activity: {
          state: activity.state,
          ...(activity.tool ? { driver: { tool: activity.tool, since: iso(activity.since ?? T0) } } : {}),
          ...(activity.lastAt !== undefined ? { lastActivityAt: iso(activity.lastAt) } : {}),
        },
      }
    : {}),
});

const driven = (lastAt = T0, since = T0) => sim({ state: 'driven', tool: 'agent-device', since, lastAt });

function env(extra: Partial<Env> = {}): Env {
  return {
    path: PATH,
    live: true,
    phase: 'live',
    worktree: { path: PATH, branch: 'wide-insets', repository: '/u/app', git: { mergedInto: null } },
    ...extra,
  };
}

interface Run {
  platform?: 'ios' | 'android';
  status: 'ok' | 'failed';
  at: number;
  file?: string;
  line?: number;
  code?: string;
}

function builds(...runs: Run[]): Pick<Env, 'builds' | 'lastBuilds'> {
  const entries = runs.map(({ platform = 'ios', status, at, file, line, code }) => {
    const build: Build = {
      platform,
      status,
      result: status === 'ok' ? 'succeeded' : 'failed',
      startedAt: iso(at - 30_000),
      finishedAt: iso(at),
    };
    if (status === 'failed') build.errorCode = code ?? 'STIM_BUILD_FAILED';
    if (file) build.diagnostics = [{ file, line: line ?? null }];
    return build;
  });
  return { builds: { ios: entries }, lastBuilds: entries[0] ? { ios: entries[0] } : {} };
}

const input = (environments: Env[], extra: Partial<OversightInput> = {}): OversightInput => ({
  machine: 'MacBook Pro',
  status: { environments },
  volumes: [{ freeBytes: 200e9 }],
  memoryPressure: 'normal',
  link: null,
  pullRequests: {},
  ownLeases: [],
  ...extra,
});

const ALL: OversightPrefs = { categories: OVERSIGHT_CATEGORIES, stuckMinutes: 15, quiet: false };

/** Feeds each step to the rules in turn, from a quiet first look, and collects what they notify. */
function run(steps: { at: number; input: OversightInput; prefs?: OversightPrefs }[]) {
  let state: OversightState | null = null;
  const sent: (OversightNotification & { at: number })[] = [];
  let wakeAt: number | null = null;
  for (const step of steps) {
    const result = oversee(state, step.input, step.prefs ?? ALL, step.at);
    state = result.state;
    wakeAt = result.wakeAt;
    for (const notification of result.notifications) sent.push(Object.assign({ at: step.at }, notification));
  }
  return { sent, wakeAt, texts: sent.map((n) => `${n.title}: ${n.body}`) };
}

describe('oversee', () => {
  it('stays quiet about what is already true at the first look', () => {
    const now = T0 + 60 * MIN;
    const { sent } = run([
      {
        at: now,
        input: input(
          [
            env({
              phase: 'warming',
              ios: driven(T0),
              ...builds(
                { status: 'failed', at: T0, file: 'A.swift', line: 1 },
                { status: 'failed', at: T0 - MIN, file: 'A.swift', line: 1 },
                { status: 'failed', at: T0 - 2 * MIN, file: 'A.swift', line: 1 },
              ),
            }),
          ],
          { volumes: [{ freeBytes: 1e9 }], memoryPressure: 'critical', link: 'offline' },
        ),
      },
    ]);
    expect(sent).toEqual([]);
  });

  it('never notifies a single failed build, log errors, a stopped app or a slow build', () => {
    const quiet = env({ ios: { ...sim(null), app: { state: 'stopped' } } as never });
    const { sent } = run([
      { at: T0, input: input([quiet]) },
      {
        at: T0 + MIN,
        input: input([
          env({
            ...builds({ status: 'failed', at: T0 + MIN }),
            logs: { errorsSinceMarker: 12 },
            build: { state: 'running', startedAt: iso(T0 - 60 * MIN) },
          }),
        ]),
      },
      { at: T0 + 2 * MIN, input: input([env({ ...builds({ status: 'failed', at: T0 + 2 * MIN, code: 'X' }) })]) },
    ]);
    expect(sent).toEqual([]);
  });

  describe('work started', () => {
    it('notifies a workspace that begins warming quietly, then updates it in place when an agent drives it', () => {
      const { sent } = run([
        { at: T0, input: input([]) },
        { at: T0 + MIN, input: input([env({ live: false, phase: 'warming' })]) },
        { at: T0 + 2 * MIN, input: input([env({ live: false, phase: 'ready' })]) },
        { at: T0 + 3 * MIN, input: input([env({ ios: driven(T0 + 3 * MIN, T0 + 3 * MIN) })]) },
        { at: T0 + 4 * MIN, input: input([env({ ios: driven(T0 + 4 * MIN, T0 + 3 * MIN) })]) },
      ]);
      expect(sent).toEqual([
        {
          at: T0 + MIN,
          id: `started:${PATH}`,
          category: 'started',
          title: 'wide-insets',
          body: 'Warming on MacBook Pro',
          quiet: true,
          thread: 'started:MacBook Pro',
          target: { kind: 'workspace', path: PATH },
        },
        {
          at: T0 + 3 * MIN,
          id: `started:${PATH}`,
          category: 'started',
          title: 'wide-insets',
          body: 'agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
          quiet: true,
          thread: 'started:MacBook Pro',
          target: { kind: 'device', path: PATH, platform: 'ios', slot: 'default' },
        },
      ]);
    });

    it('counts an agent driving the owned Chrome page, and opens it in the device viewer', () => {
      const web = (state: string) => ({
        running: true,
        activity: { state, ...(state === 'driven' ? { driver: { tool: 'agent-browser', since: iso(T0 + MIN) } } : {}) },
      });
      const { sent } = run([
        { at: T0, input: input([env({ web: web('idle') })]) },
        { at: T0 + MIN, input: input([env({ web: web('driven') })]) },
      ]);
      expect(sent.map((n) => [n.body, n.target])).toEqual([
        [
          'agent-browser started driving Chrome on MacBook Pro',
          { kind: 'device', path: PATH, platform: 'web', slot: 'default' },
        ],
      ]);
    });

    it('does not count a phone controlling the device through stim-server as an agent', () => {
      const lease = iso(T0 + MIN);
      const phone = sim({ state: 'driven', tool: 'stim device lock', since: T0 + MIN, lastAt: T0 });
      const { sent } = run([
        { at: T0, input: input([env({ ios: sim(null) })]) },
        { at: T0 + MIN, input: input([env({ ios: phone })], { ownLeases: [lease] }) },
      ]);
      expect(sent).toEqual([]);
    });
  });

  describe('agent looks stuck', () => {
    it('notifies once when a driven workspace shows no activity for the threshold, and again after new activity', () => {
      const steps = [
        { at: T0, input: input([env({ ios: sim(null) })]) },
        { at: T0 + MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
        { at: T0 + 10 * MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
      ];
      expect(run(steps).wakeAt).toBe(T0 + 16 * MIN);
      const { sent, texts } = run([
        ...steps,
        { at: T0 + 16 * MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
        { at: T0 + 30 * MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
        { at: T0 + 31 * MIN, input: input([env({ ios: driven(T0 + 31 * MIN, T0 + MIN) })]) },
        { at: T0 + 46 * MIN, input: input([env({ ios: driven(T0 + 31 * MIN, T0 + MIN) })]) },
      ]);
      expect(texts).toEqual([
        'wide-insets: agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
        'wide-insets: No agent activity for 15 min; iPhone 18 Pro 27.0 still up',
        'wide-insets: No agent activity for 15 min; iPhone 18 Pro 27.0 still up',
      ]);
      expect(sent[1]).toMatchObject({
        id: `stuck:${PATH}`,
        quiet: false,
        target: { kind: 'device', path: PATH, platform: 'ios', slot: 'default' },
      });
    });

    it('waits for the threshold the phone chose, and counts a running build and new log errors as activity', () => {
      const prefs = { ...ALL, stuckMinutes: 30 };
      const { texts } = run([
        { at: T0, input: input([env({ ios: sim(null) })]), prefs },
        { at: T0 + MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]), prefs },
        {
          at: T0 + 25 * MIN,
          input: input([env({ ios: driven(T0 + MIN, T0 + MIN), logs: { errorsSinceMarker: 2 } })]),
          prefs,
        },
        {
          at: T0 + 50 * MIN,
          input: input([
            env({
              ios: driven(T0 + MIN, T0 + MIN),
              logs: { errorsSinceMarker: 2 },
              build: { state: 'running', startedAt: iso(T0 + 26 * MIN) },
            }),
          ]),
          prefs,
        },
        {
          at: T0 + 54 * MIN,
          input: input([env({ ios: driven(T0 + MIN, T0 + MIN), logs: { errorsSinceMarker: 2 } })]),
          prefs,
        },
        {
          at: T0 + 55 * MIN,
          input: input([env({ ios: driven(T0 + MIN, T0 + MIN), logs: { errorsSinceMarker: 2 } })]),
          prefs,
        },
      ]);
      expect(texts).toEqual([
        'wide-insets: agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
        'wide-insets: No agent activity for 30 min; iPhone 18 Pro 27.0 still up',
      ]);
    });

    it('names the green build an agent went quiet after while still holding the device', () => {
      const { texts } = run([
        { at: T0, input: input([env({ ios: sim(null) })]) },
        {
          at: T0 + MIN,
          input: input([env({ ios: driven(T0 + MIN, T0 + MIN), ...builds({ status: 'ok', at: T0 + MIN }) })]),
        },
        {
          at: T0 + 16 * MIN,
          input: input([env({ ios: driven(T0 + MIN, T0 + MIN), ...builds({ status: 'ok', at: T0 + MIN }) })]),
        },
      ]);
      expect(texts.at(-1)).toBe(
        'wide-insets: No agent activity for 15 min after a green iOS build; iPhone 18 Pro 27.0 still up',
      );
    });

    it('does not count app log records as activity, only agent actions, reloads and Stim runs', () => {
      const chatty = (logAt: number, actedAt = T0 + MIN) => ({
        ...driven(logAt, T0 + MIN),
        activity: {
          state: 'driven',
          driver: { tool: 'agent-device', since: iso(T0 + MIN) },
          lastActivityAt: iso(logAt),
          recent: { 'device-log': iso(logAt), 'agent-action': iso(actedAt) },
        },
      });
      const { texts } = run([
        { at: T0, input: input([env({ ios: sim(null) })]) },
        { at: T0 + MIN, input: input([env({ ios: chatty(T0 + MIN) })]) },
        { at: T0 + 16 * MIN, input: input([env({ ios: chatty(T0 + 16 * MIN) })]) },
        { at: T0 + 20 * MIN, input: input([env({ ios: chatty(T0 + 20 * MIN, T0 + 19 * MIN) })]) },
        { at: T0 + 30 * MIN, input: input([env({ ios: chatty(T0 + 30 * MIN, T0 + 19 * MIN) })]) },
      ]);
      expect(texts).toEqual([
        'wide-insets: agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
        'wide-insets: No agent activity for 15 min; iPhone 18 Pro 27.0 still up',
      ]);
    });

    it('leaves a workspace alone once its devices are shut down', () => {
      const { texts } = run([
        { at: T0, input: input([env({ ios: sim(null) })]) },
        { at: T0 + MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
        { at: T0 + 30 * MIN, input: input([env({ ios: sim({ state: 'idle', lastAt: T0 + MIN }, 'Shutdown') })]) },
      ]);
      expect(texts).toEqual(['wide-insets: agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro']);
    });
  });

  describe('agent is looping', () => {
    const failure = (at: number, line = 71) => ({
      status: 'failed' as const,
      at,
      file: '/u/app/ios/AppDelegate.swift',
      line,
    });

    it('notifies the third failure at the same place once, with the build details as its target', () => {
      const { sent } = run([
        { at: T0, input: input([env()]) },
        { at: T0 + MIN, input: input([env(builds(failure(T0 + MIN)))]) },
        { at: T0 + 2 * MIN, input: input([env(builds(failure(T0 + 2 * MIN), failure(T0 + MIN)))]) },
        {
          at: T0 + 3 * MIN,
          input: input([env(builds(failure(T0 + 3 * MIN), failure(T0 + 2 * MIN), failure(T0 + MIN)))]),
        },
        {
          at: T0 + 4 * MIN,
          input: input([
            env(builds(failure(T0 + 4 * MIN), failure(T0 + 3 * MIN), failure(T0 + 2 * MIN), failure(T0 + MIN))),
          ]),
        },
      ]);
      expect(sent).toEqual([
        {
          at: T0 + 3 * MIN,
          id: `looping-ios:${PATH}`,
          category: 'looping',
          title: 'wide-insets',
          body: 'Same Swift error 3x at AppDelegate.swift:71',
          quiet: false,
          thread: null,
          target: { kind: 'build', path: PATH, platform: 'ios' },
        },
      ]);
    });

    it('starts over after a success or a different failure, and names repeated launch failures', () => {
      const launch = (at: number) => ({ status: 'failed' as const, at, code: 'STIM_LAUNCH_FAILED' });
      const { texts } = run([
        { at: T0, input: input([env()]) },
        { at: T0 + MIN, input: input([env(builds(failure(T0 + MIN), failure(T0), failure(T0 - MIN, 12)))]) },
        {
          at: T0 + 2 * MIN,
          input: input([env(builds({ status: 'ok', at: T0 + 2 * MIN }, failure(T0 + MIN), failure(T0)))]),
        },
        {
          at: T0 + 3 * MIN,
          input: input([env(builds(launch(T0 + 3 * MIN), launch(T0 + 2.5 * MIN), launch(T0 + 2.2 * MIN)))]),
        },
      ]);
      expect(texts).toEqual(['wide-insets: App failed to launch on iOS 3x in a row']);
    });
  });

  describe('work finished', () => {
    const drove = [
      { at: T0, input: input([env({ ios: sim(null) })]) },
      { at: T0 + MIN, input: input([env({ ios: driven(T0 + MIN, T0 + MIN) })]) },
    ];

    it('notifies once when the agent stops after a green build and nothing happens for five minutes', () => {
      const green = builds({ status: 'ok', at: T0 + 2 * MIN });
      const released = sim({ state: 'active', lastAt: T0 + 2 * MIN });
      const steps = [...drove, { at: T0 + 3 * MIN, input: input([env({ ios: released, ...green })]) }];
      expect(run(steps).wakeAt).toBe(T0 + 7 * MIN);
      const { sent } = run([
        ...steps,
        { at: T0 + 8 * MIN, input: input([env({ ios: released, ...green })]) },
        { at: T0 + 60 * MIN, input: input([env({ ios: released, ...green })]) },
      ]);
      expect(sent).toEqual([
        expect.objectContaining({ category: 'started' }),
        {
          at: T0 + 8 * MIN,
          id: `finished:${PATH}`,
          category: 'finished',
          title: 'wide-insets',
          body: 'Agent stopped after a green iOS build',
          quiet: false,
          thread: null,
          target: { kind: 'workspace', path: PATH },
        },
      ]);
    });

    it('notifies at once when the agent stops the workspace after a green build, and not after a red one', () => {
      const stopped = { live: false, phase: 'idle', ios: sim(null, 'Shutdown') };
      const { texts } = run([
        ...drove,
        { at: T0 + 3 * MIN, input: input([env({ ...stopped, ...builds({ status: 'ok', at: T0 + 2 * MIN }) })]) },
      ]);
      expect(texts.at(-1)).toBe('wide-insets: Agent stopped after a green iOS build');
      const red = run([
        ...drove,
        { at: T0 + 3 * MIN, input: input([env({ ...stopped, ...builds({ status: 'failed', at: T0 + 2 * MIN }) })]) },
        { at: T0 + 60 * MIN, input: input([env({ ...stopped, ...builds({ status: 'failed', at: T0 + 2 * MIN }) })]) },
      ]);
      expect(red.texts).toHaveLength(1);
    });

    it('notifies a pull request once it is ready for review and once it merged, after a quiet first lookup', () => {
      const pr = (state: 'open' | 'merged', draft: boolean) => ({
        [PATH]: { number: 42, state, draft, url: 'https://github.com/o/r/pull/42' },
      });
      const { sent } = run([
        { at: T0, input: input([env()]) },
        { at: T0 + MIN, input: input([env()], { pullRequests: { [PATH]: null } }) },
        { at: T0 + 2 * MIN, input: input([env()], { pullRequests: pr('open', true) }) },
        { at: T0 + 3 * MIN, input: input([env()], { pullRequests: pr('open', false) }) },
        { at: T0 + 4 * MIN, input: input([env()], { pullRequests: pr('open', false) }) },
        { at: T0 + 5 * MIN, input: input([env()], { pullRequests: pr('merged', false) }) },
        {
          at: T0 + 6 * MIN,
          input: input([env({ worktree: { path: PATH, branch: 'wide-insets', git: { mergedInto: 'origin/main' } } })], {
            pullRequests: pr('merged', false),
          }),
        },
      ]);
      expect(sent.map((n) => [n.at, n.body, n.target])).toEqual([
        [
          T0 + 3 * MIN,
          'PR #42 is ready for review',
          { kind: 'url', path: PATH, url: 'https://github.com/o/r/pull/42' },
        ],
        [T0 + 5 * MIN, 'PR #42 merged', { kind: 'url', path: PATH, url: 'https://github.com/o/r/pull/42' }],
      ]);
      expect(new Set(sent.map((n) => n.id))).toEqual(new Set([`finished:${PATH}`]));
    });

    it('stays quiet about a pull request that was already open or merged at its first lookup', () => {
      const merged = { [PATH]: { number: 7, state: 'merged' as const, draft: false, url: 'u' } };
      const { sent } = run([
        { at: T0, input: input([env()]) },
        { at: T0 + MIN, input: input([env()], { pullRequests: merged }) },
        { at: T0 + 2 * MIN, input: input([env()], { pullRequests: merged }) },
      ]);
      expect(sent).toEqual([]);
    });

    it('falls back to git when GitHub is unavailable: a branch that becomes merged into the default branch', () => {
      const git = (mergedInto: string | null) =>
        env({ worktree: { path: PATH, branch: 'wide-insets', git: { mergedInto } } });
      const unknown = env({ worktree: { path: PATH, branch: 'wide-insets', git: null } });
      const { texts } = run([
        { at: T0, input: input([git('origin/main')]) },
        { at: T0 + MIN, input: input([git(null)]) },
        { at: T0 + 2 * MIN, input: input([unknown]) },
        { at: T0 + 3 * MIN, input: input([git(null)]) },
        { at: T0 + 4 * MIN, input: input([git('origin/main')]) },
        { at: T0 + 5 * MIN, input: input([git('origin/main')]) },
      ]);
      expect(texts).toEqual(['wide-insets: Merged into origin/main']);
    });
  });

  describe('machine in trouble', () => {
    it('notifies low disk once, critical memory pressure after a minute, and an offline machine after a minute', () => {
      const low = { volumes: [{ freeBytes: 3e9 }] };
      const { sent } = run([
        { at: T0, input: input([], { link: 'open' }) },
        { at: T0 + MIN, input: input([], { ...low, link: 'open' }) },
        { at: T0 + 2 * MIN, input: input([], { ...low, link: 'open', memoryPressure: 'critical' }) },
        { at: T0 + 2.5 * MIN, input: input([], { ...low, link: 'open', memoryPressure: 'critical' }) },
        { at: T0 + 3 * MIN, input: input([], { ...low, link: 'open', memoryPressure: 'critical' }) },
        { at: T0 + 4 * MIN, input: input([], { ...low, link: 'offline', status: null }) },
        { at: T0 + 4.5 * MIN, input: input([], { ...low, link: 'offline', status: null }) },
        { at: T0 + 5 * MIN, input: input([], { ...low, link: 'offline', status: null }) },
      ]);
      expect(sent.map((n) => [n.at, n.id, n.title, n.body, n.target.kind])).toEqual([
        [T0 + MIN, 'machine:disk', 'MacBook Pro', "3.0 GB free, below Stim's floor", 'machine'],
        [T0 + 3 * MIN, 'machine:memory', 'MacBook Pro', 'Memory pressure is critical', 'machine'],
        [T0 + 5 * MIN, 'machine:link', 'MacBook Pro', 'Offline', 'machine'],
      ]);
    });
  });

  it('keeps one low-disk episode while free space hovers at the floor, and stays quiet about a first reading', () => {
    const free = (gb: number, memoryPressure: OversightInput['memoryPressure'] = 'normal') =>
      input([], { volumes: [{ freeBytes: gb * 1e9 }], memoryPressure });
    const { sent } = run([
      { at: T0, input: free(200, null) },
      { at: T0 + MIN, input: free(4.9, 'critical') },
      { at: T0 + 3 * MIN, input: free(5.1, 'critical') },
      { at: T0 + 4 * MIN, input: free(4.9, 'critical') },
      { at: T0 + 5 * MIN, input: free(6.5, 'critical') },
      { at: T0 + 6 * MIN, input: free(4.9, 'critical') },
    ]);
    expect(sent.map((n) => [n.at, n.id])).toEqual([
      [T0 + MIN, 'machine:disk'],
      [T0 + 6 * MIN, 'machine:disk'],
    ]);
  });

  describe('preferences', () => {
    it('holds a lasting problem through quiet hours and drops the events that happened during them', () => {
      const quiet = { ...ALL, quiet: true };
      const failing = (n: number) =>
        env(
          builds(
            ...Array.from({ length: n }, (_, i) => ({ status: 'failed' as const, at: T0 + (n - i) * MIN, code: 'E' })),
          ),
        );
      const { sent } = run([
        { at: T0, input: input([]) },
        { at: T0 + MIN, input: input([{ ...failing(3), live: false, phase: 'warming' }]), prefs: quiet },
        { at: T0 + 2 * MIN, input: input([failing(3)]), prefs: quiet },
        { at: T0 + 3 * MIN, input: input([failing(3)]) },
      ]);
      expect(sent.map((n) => [n.at, n.body])).toEqual([[T0 + 3 * MIN, 'iOS build failed 3x in a row (E)']]);
    });

    it('drops what a switched-off category finds, so switching it on later does not notify the past', () => {
      const off = { ...ALL, categories: OVERSIGHT_CATEGORIES.filter((c) => c !== 'looping') };
      const failing = env(
        builds(
          { status: 'failed', at: T0 + 3 * MIN, code: 'E' },
          { status: 'failed', at: T0 + 2 * MIN, code: 'E' },
          { status: 'failed', at: T0 + MIN, code: 'E' },
        ),
      );
      const { sent } = run([
        { at: T0, input: input([]) },
        { at: T0 + MIN, input: input([failing]), prefs: off },
        { at: T0 + 2 * MIN, input: input([failing]) },
      ]);
      expect(sent).toEqual([]);
    });
  });
});

describe('inQuietHours', () => {
  it('reads a range within a day and one that spans midnight', () => {
    expect(inQuietHours({ start: 60, end: 120 }, 90)).toBe(true);
    expect(inQuietHours({ start: 60, end: 120 }, 120)).toBe(false);
    expect(inQuietHours({ start: 22 * 60, end: 7 * 60 }, 23 * 60)).toBe(true);
    expect(inQuietHours({ start: 22 * 60, end: 7 * 60 }, 6 * 60)).toBe(true);
    expect(inQuietHours({ start: 22 * 60, end: 7 * 60 }, 12 * 60)).toBe(false);
    expect(inQuietHours(null, 0)).toBe(false);
  });
});
