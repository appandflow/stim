import { lastNativeUseFrom, readBuildHistory, readLastBuilds } from '../state/workspace-state.ts';

describe('last native run of a workspace', () => {
  test('is when the newest ios, android or macos run finished, ignoring dev server use', () => {
    const state = {
      lastUsedAt: '2026-09-10T00:00:00Z',
      supervisor: { startedAt: '2026-09-10T00:00:00Z' },
      lastIosBuild: { platform: 'ios', status: 'success', startedAt: '2026-09-01T00:00:00Z', durationMs: 0 },
      buildHistory: {
        macos: [{ platform: 'macos', status: 'success', startedAt: '2026-09-05T00:00:00Z', durationMs: 60_000 }],
      },
    };
    expect(lastNativeUseFrom(state)).toBe(Date.parse('2026-09-05T00:01:00Z'));
    expect(lastNativeUseFrom({ lastUsedAt: '2026-09-10T00:00:00Z' })).toBeNaN();
  });
});

describe('last build per platform', () => {
  const ios = {
    platform: 'ios',
    fingerprint: 'abc',
    cacheHit: 'remote',
    cacheSkipped: false,
    durationMs: 42_000,
    startedAt: '2026-09-25T10:00:00.000Z',
    status: 'ok',
  };

  test('a failed build reports its first diagnostics, positioned ones first, bounded, and drops malformed ones', () => {
    const diagnostics = [
      { file: '/app/ios/App/AppDelegate.swift', line: 71, column: 24, message: 'cannot convert value', remedy: 'x' },
      { message: 'linker command failed', line: 0 },
      { file: 'a', line: 1 },
      { file: 'a', line: -2, message: 'b' },
      ...Array.from({ length: 6 }, (_, i) => ({ message: `m${i}` })),
    ];
    const failed = { ...ios, cacheHit: false, status: 'failed', errorCode: 'STIM_BUILD_FAILED', diagnostics };
    expect(readLastBuilds({ lastBuild: failed }).ios?.diagnostics).toEqual([
      { file: '/app/ios/App/AppDelegate.swift', line: 71, column: 24, message: 'cannot convert value' },
      { file: 'a', line: null, column: null, message: 'b' },
      { file: null, line: null, column: null, message: 'linker command failed' },
      { file: null, line: null, column: null, message: 'm0' },
      { file: null, line: null, column: null, message: 'm1' },
    ]);
    expect(readLastBuilds({ lastBuild: { ...ios, diagnostics } }).ios).not.toHaveProperty('diagnostics');
  });

  test('a miss reason is reported for a compiled run, bounded, and dropped from a cache hit', () => {
    const missReason = {
      kind: 'changed',
      summary: 'native dependency added: expo-clipboard',
      changes: [
        ...Array.from({ length: 25 }, (_, i) => ({ source: `f${i}`, change: 'changed', category: 'file' })),
        { source: 'bad', change: 'renamed' },
      ],
      changeCount: 40,
      baseline: { fingerprint: 'old', from: 'elsewhere' },
      rekeyedBy: ['prebuild', 3],
    };
    const compiled = readLastBuilds({ lastBuild: { ...ios, cacheHit: false, missReason } }).ios?.missReason;
    expect(compiled).toMatchObject({ kind: 'changed', changeCount: 40, baseline: null, rekeyedBy: ['prebuild'] });
    expect(compiled?.changes).toHaveLength(20);
    expect(readLastBuilds({ lastBuild: { ...ios, missReason } }).ios?.missReason).toBeUndefined();
    expect(
      readLastBuilds({ lastBuild: { ...ios, cacheHit: false, missReason: { kind: 'bogus', summary: 'x' } } }).ios
        ?.missReason,
    ).toBeUndefined();
  });
});

describe('build history per platform', () => {
  const entry = (startedAt: string, extra: Record<string, unknown> = {}) => ({
    platform: 'ios',
    status: 'ok',
    result: 'succeeded',
    startedAt,
    durationMs: 1000,
    cacheHit: false,
    ...extra,
  });

  test('an entry without a known result takes it from its status', () => {
    const history = readBuildHistory({
      buildHistory: { ios: [entry('2026-09-20T00:00:00Z', { status: 'failed', result: 'exploded' })] },
    });
    expect(history.ios![0]!.result).toBe('failed');
  });
});
