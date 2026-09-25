import { activityBadge, buildProgress } from '@/lib/format';
import type { BuildReport } from '@/protocol/types';

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
