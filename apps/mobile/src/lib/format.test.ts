import {
  activityBadge,
  buildProgress,
  gitBadges,
  lastBuildSummary,
  outcomeLabel,
  planExpectation,
  planSummary,
} from '@/lib/format';
import type { BuildPlan, BuildReport } from '@/protocol/types';

const now = Date.parse('2026-09-25T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('activityBadge', () => {
  it('shows no idle badge for a device used in the last 10 minutes', () => {
    expect(activityBadge({ state: 'idle', lastActivityAt: ago(9 * 60_000), basis: [] }, now)).toBeNull();
    expect(activityBadge({ state: 'idle', lastActivityAt: ago(3 * 3600_000), basis: [] }, now)?.text).toBe('Idle 3h');
  });

  it('names the tool driving the device and for how long', () => {
    const badge = activityBadge(
      { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: ago(12 * 60_000) }, basis: [] },
      now,
    );
    expect(badge).toEqual({ kind: 'driven', text: 'Driven by agent-device \u00B7 12m' });
  });
});

describe('buildProgress', () => {
  const build = (expectedMs: number | null): BuildReport => ({
    platform: 'ios',
    slot: 'default',
    state: 'running',
    phase: 'compile',
    startedAt: ago(90_000),
    phaseStartedAt: ago(30_000),
    outcome: expectedMs ? 'cold' : null,
    expectedMs,
    expectedPhaseMs: null,
    basis: expectedMs ? 5 : 0,
  });

  it('is indeterminate without comparable runs', () => {
    expect(buildProgress(build(null), now)).toEqual({ elapsedMs: 90_000, fraction: null, remaining: null });
  });

  it('never reaches 100% while the build still runs', () => {
    expect(buildProgress(build(300_000), now)).toMatchObject({ fraction: 0.3, remaining: 'about 4 min left' });
    expect(buildProgress(build(60_000), now)).toMatchObject({ fraction: 0.99, remaining: 'longer than usual' });
  });
});

describe('build cache outcome', () => {
  it('marks the running outcome likely until the run reaches a phase that settles it', () => {
    expect(outcomeLabel({ outcome: 'cold', phase: 'cache-lookup' })).toBe('Likely cold');
    expect(outcomeLabel({ outcome: 'cold', phase: 'compile' })).toBe('Cold build');
    expect(outcomeLabel({ outcome: 'hit', phase: 'install' })).toBe('Cache hit');
    expect(outcomeLabel({ outcome: null, phase: 'prepare' })).toBeNull();
  });

  it('reads a last build whose cacheHit is false as compiled, and a failed one by its code', () => {
    const last = {
      platform: 'ios' as const,
      status: 'ok' as const,
      cacheHit: false as const,
      cacheSkipped: false,
      durationMs: 83_123,
      fingerprint: '1b62',
      startedAt: ago(90_000),
      finishedAt: ago(7_000),
    };
    expect(lastBuildSummary(last, now)).toBe('Cache miss, compiled in 1:23 \u00B7 <1m ago');
    expect(lastBuildSummary({ ...last, cacheSkipped: true }, now)).toBe('Compiled in 1:23 \u00B7 <1m ago');
    expect(
      lastBuildSummary(
        { ...last, status: 'failed', errorCode: 'STIM_BUILD_FAILED', finishedAt: ago(3 * 3600_000) },
        now,
      ),
    ).toBe('Failed (STIM_BUILD_FAILED) in 1:23 \u00B7 3h ago');
  });

  it('describes a planned hit, a miss that regenerates, and a refusal', () => {
    const hit: BuildPlan = {
      platform: 'ios',
      fingerprint: '1b62',
      cacheKey: 'k',
      cacheHit: 'remote',
      provider: 'eas',
      cacheSkipped: false,
      prebuild: null,
      outcome: 'hit',
      expectedMs: 2656,
      basis: 1,
    };
    expect([planSummary(hit), planExpectation(hit)]).toEqual(['Remote cache hit (eas)', '~0:02, median of 1 hit run']);
    const miss: BuildPlan = {
      ...hit,
      cacheHit: false,
      provider: null,
      prebuild: 'regenerate',
      outcome: 'cold',
      expectedMs: null,
      basis: 0,
    };
    expect([planSummary(miss), planExpectation(miss)]).toEqual([
      'Cache miss: compiles, regenerates the native dir',
      'No cold run of this project recorded yet',
    ]);
    const refused: BuildPlan = {
      ...miss,
      outcome: null,
      refusal: { code: 'STIM_EAS_BUILD_MISSING', message: 'No build.', remedy: 'Build one.' },
    };
    expect([planSummary(refused), planExpectation(refused)]).toEqual(['Would refuse: STIM_EAS_BUILD_MISSING', null]);
  });
});

describe('gitBadges', () => {
  const git = { changed: 0, untracked: 0, upstream: 'origin/x', ahead: 0, behind: 0, mergedInto: null };

  it('shows nothing for a clean branch level with its upstream, or when git is unknown', () => {
    expect(gitBadges(git)).toBeNull();
    expect(gitBadges(null)).toBeNull();
    expect(gitBadges({ ...git, upstream: null, ahead: null, behind: null })).toBeNull();
  });

  it('counts changed and untracked files together and shows ahead and behind as arrows', () => {
    expect(gitBadges({ ...git, changed: 2, untracked: 1, ahead: 3, behind: 1 })).toEqual({
      uncommitted: 3,
      arrows: '↑3 ↓1',
      merged: false,
      label: '3 uncommitted changes, 3 ahead, 1 behind',
    });
  });

  it('flags a merged branch', () => {
    expect(gitBadges({ ...git, ahead: null, behind: null, mergedInto: 'origin/main' })).toEqual({
      uncommitted: 0,
      arrows: null,
      merged: true,
      label: 'merged into origin/main',
    });
  });
});
