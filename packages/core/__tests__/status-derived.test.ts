import { readFileSync } from 'node:fs';

import type { BuildHistoryEntry, EnvironmentState, StatsPlatform, WorktreeFacts } from '../state/status.ts';
import { withDerivedFacts, withGitChip } from '../state/status-derived.ts';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../apps/desktop/Tests/StimKitTests/Fixtures/workspace-view-vectors.json', import.meta.url),
    'utf-8',
  ),
) as {
  stage: { name: string; workspace: EnvironmentState; derived: unknown }[];
  gitChip: { name: string; worktree: WorktreeFacts; derived: unknown }[];
  appPresence: {
    name: string;
    workspace: EnvironmentState;
    platform: StatsPlatform;
    slot: string;
    presence: string | null;
  }[];
};

describe('workspace view vectors', () => {
  test.each(vectors.stage.map((c) => [c.name, c] as const))('stage: %s', (_, c) => {
    expect(withDerivedFacts(c.workspace).stage).toEqual(c.derived);
  });

  test.each(vectors.gitChip.map((c) => [c.name, c] as const))('git chip: %s', (_, c) => {
    expect(withGitChip(c.worktree).gitChip).toEqual(c.derived);
  });

  test.each(vectors.appPresence.map((c) => [c.name, c] as const))('app presence: %s', (_, c) => {
    const env = withDerivedFacts(c.workspace);
    const slot = c.slot === 'default' ? env : env.slots?.find((candidate) => candidate.slot === c.slot);
    expect(slot?.[c.platform]?.appPresence).toBe(c.presence);
  });
});

const run = (patch: Partial<BuildHistoryEntry>): BuildHistoryEntry => ({
  platform: 'ios',
  status: 'failed',
  cacheHit: false,
  cacheSkipped: false,
  durationMs: 1000,
  fingerprint: null,
  startedAt: '2026-09-27T11:50:00.000Z',
  finishedAt: '2026-09-27T11:51:00.000Z',
  result: 'failed',
  slot: 'default',
  configuration: 'Debug',
  cacheKey: null,
  phases: {},
  ...patch,
});

const env = (patch: Partial<EnvironmentState>): EnvironmentState => ({
  path: '/w',
  live: false,
  memoryMb: 0,
  warnings: [],
  issues: [],
  ...patch,
});

const causes = (builds: BuildHistoryEntry[]) =>
  withDerivedFacts(env({ builds: { ios: builds } })).builds?.ios?.map((build) => build.cause ?? null);

describe('failed run causes', () => {
  test('the first diagnostic with a file and a line names the cause', () => {
    const diagnostics = [
      { file: null, line: null, column: null, message: 'ld: error' },
      { file: '/w/App.swift', line: null, column: null, message: 'no line' },
      { file: '/w/App.swift', line: 12, column: 3, message: 'type error' },
    ];
    expect(causes([run({ diagnostics, errorCode: 'STIM_BUILD_FAILED' })])).toEqual([
      { key: '/w/App.swift:12', file: '/w/App.swift', line: 12 },
    ]);
  });

  test('without a located diagnostic the error code is the cause, else a bare failure', () => {
    expect(causes([run({ errorCode: 'STIM_LAUNCH_FAILED' }), run({})])).toEqual([
      { key: 'STIM_LAUNCH_FAILED', file: null, line: null },
      { key: 'failed', file: null, line: null },
    ]);
  });

  test('only a failed run has a cause, so a cancelled run ends a streak of failures', () => {
    expect(causes([run({ result: 'cancelled' }), run({ result: 'succeeded', status: 'ok' })])).toEqual([null, null]);
  });

  test('the last build of each platform carries its cause', () => {
    const { result: _, ...failed } = run({ platform: 'android', errorCode: 'STIM_INSTALL_FAILED' });
    const derived = withDerivedFacts(env({ lastBuilds: { android: failed } }));
    expect(derived.lastBuilds?.android?.cause?.key).toBe('STIM_INSTALL_FAILED');
    expect(derived.lastBuilds).not.toHaveProperty('ios');
  });
});

describe('withDerivedFacts', () => {
  test('derives every device, worktree and build the payload carries, without touching the input', () => {
    const sim = {
      name: 'stim-w',
      udid: 'U',
      owned: true,
      state: 'Booted',
      app: { id: 'a', state: 'stopped' as const },
    };
    const input = env({
      live: true,
      ios: sim,
      android: null,
      slots: [{ slot: 'b', ios: { ...sim, app: { id: 'a', state: 'running' } }, android: null }],
      worktree: {
        path: '/w',
        git: { changed: 1, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: null },
      },
      builds: { ios: [run({ status: 'ok', result: 'succeeded' })] },
    });
    const before = structuredClone(input);
    const derived = withDerivedFacts(input);

    expect(input).toEqual(before);
    expect(derived.stage).toEqual({
      kind: 'running',
      since: null,
      platform: null,
      closedApps: [{ platform: 'ios', slot: 'default' }],
    });
    expect(derived.ios?.appPresence).toBe('closed');
    expect(derived.android).toBeNull();
    expect(derived.slots?.[0]?.ios?.appPresence).toBeNull();
    expect(derived.worktree?.gitChip?.parts).toEqual([{ kind: 'changed', count: 1 }, { kind: 'no-upstream' }]);
  });
});
