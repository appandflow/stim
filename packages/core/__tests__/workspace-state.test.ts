import { BUILD_HISTORY_LIMIT, lastUseFrom, readBuildHistory, readLastBuilds } from '../state/workspace-state.ts';

describe('last use of a workspace', () => {
  const at = (iso: string) => Date.parse(iso);

  test('newer evidence than the recorded lastUsedAt wins, so a long Metro session is not idle', () => {
    expect(
      lastUseFrom({ lastUsedAt: '2026-09-01T00:00:00Z', lastBuild: { startedAt: '2026-09-20T00:00:00Z' } }, [
        at('2026-09-21T00:00:00Z'),
      ]),
    ).toBe(at('2026-09-21T00:00:00Z'));
    expect(lastUseFrom({ lastUsedAt: '2026-09-22T00:00:00Z' }, [at('2026-09-21T00:00:00Z')])).toBe(
      at('2026-09-22T00:00:00Z'),
    );
  });

  test('without lastUsedAt, the newest of the last build, the supervisor start and the log mtimes is used', () => {
    const state = {
      lastBuild: { startedAt: '2026-09-02T00:00:00Z' },
      supervisor: { startedAt: '2026-09-05T00:00:00Z' },
    };
    expect(lastUseFrom(state, [at('2026-09-03T00:00:00Z')])).toBe(at('2026-09-05T00:00:00Z'));
    expect(lastUseFrom(state, [at('2026-09-07T00:00:00Z')])).toBe(at('2026-09-07T00:00:00Z'));
  });

  test('a workspace with no evidence of use has no last use', () => {
    expect(lastUseFrom(null, [])).toBeNaN();
    expect(lastUseFrom({ lastUsedAt: 'garbage' }, [])).toBeNaN();
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

  test('each platform keeps its own record, so an android run does not hide the last ios build', () => {
    const android = { ...ios, platform: 'android', cacheHit: false, status: 'failed', errorCode: 'STIM_BUILD_FAILED' };
    expect(readLastBuilds({ lastIosBuild: ios, lastAndroidBuild: android, lastBuild: android })).toEqual({
      ios: {
        platform: 'ios',
        status: 'ok',
        cacheHit: 'remote',
        cacheSkipped: false,
        durationMs: 42_000,
        fingerprint: 'abc',
        startedAt: '2026-09-25T10:00:00.000Z',
        finishedAt: '2026-09-25T10:00:42.000Z',
      },
      android: expect.objectContaining({ status: 'failed', cacheHit: false, errorCode: 'STIM_BUILD_FAILED' }),
    });
  });

  test('a state written before the per-platform keys reports its single lastBuild under its platform', () => {
    expect(readLastBuilds({ lastBuild: ios })).toEqual({ ios: expect.objectContaining({ cacheHit: 'remote' }) });
    expect(readLastBuilds({ lastBuild: { ...ios, status: 'running' } })).toEqual({});
  });

  test('a newer lastBuild wins over an older per-platform record, as after an older Stim ran', () => {
    const newer = { ...ios, cacheHit: 'local', startedAt: '2026-09-25T11:00:00.000Z' };
    expect(readLastBuilds({ lastIosBuild: ios, lastBuild: newer }).ios).toMatchObject({ cacheHit: 'local' });
  });

  test('a duration too large for a date leaves finishedAt null instead of failing status', () => {
    expect(readLastBuilds({ lastBuild: { ...ios, durationMs: 1e308 } }).ios).toMatchObject({ finishedAt: null });
  });

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

  test('drops entries it cannot read, bounds each list, and keeps the baseline cache key out of the report', () => {
    const ios = [
      entry('2026-09-20T00:00:00Z', {
        slot: 'tablet',
        configuration: 'Release',
        phases: { compile: 900.4, unknown: 5, install: -1 },
        missReason: {
          kind: 'changed',
          summary: 'package.json changed',
          changes: [],
          changeCount: 0,
          baseline: { fingerprint: 'old', cacheKey: 'old-key', from: 'workspace' },
          rekeyedBy: [],
        },
      }),
      { platform: 'android', status: 'ok', startedAt: '2026-09-19T00:00:00Z' },
      'not a record',
      ...Array.from({ length: BUILD_HISTORY_LIMIT + 3 }, (_, i) => entry(`2026-09-1${i % 9}T00:00:00Z`)),
    ];
    const history = readBuildHistory({ buildHistory: { ios, android: 'nope' } });
    expect(history.android).toBeUndefined();
    expect(history.ios).toHaveLength(BUILD_HISTORY_LIMIT - 2);
    expect(history.ios![0]).toMatchObject({
      result: 'succeeded',
      slot: 'tablet',
      configuration: 'Release',
      cacheKey: null,
      phases: { compile: 900 },
      finishedAt: '2026-09-20T00:00:01.000Z',
    });
    expect(history.ios![0]!.missReason?.baseline).toEqual({ fingerprint: 'old', from: 'workspace' });
    expect(history.ios![1]).toMatchObject({ slot: 'default', configuration: null, phases: {} });
  });

  test('an entry without a known result takes it from its status', () => {
    const history = readBuildHistory({
      buildHistory: { ios: [entry('2026-09-20T00:00:00Z', { status: 'failed', result: 'exploded' })] },
    });
    expect(history.ios![0]!.result).toBe('failed');
  });
});
