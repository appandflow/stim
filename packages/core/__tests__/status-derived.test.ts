import type { BuildHistoryEntry, EnvironmentState } from '../state/status.ts';
import { withDerivedFacts } from '../state/status-derived.ts';

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
