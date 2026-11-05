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

  test('only a failed run has a cause, so a cancelled run ends a streak of failures', () => {
    expect(causes([run({ result: 'cancelled' }), run({ result: 'succeeded', status: 'ok' })])).toEqual([null, null]);
  });
});
