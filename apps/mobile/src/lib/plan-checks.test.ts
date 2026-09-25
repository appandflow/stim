import { PLAN_FRESH_MS, PlanChecks } from '@/lib/plan-checks';
import type { BuildPlan, Platform } from '@/protocol/types';

const plan = (platform: Platform): BuildPlan => ({
  platform,
  fingerprint: 'f',
  cacheKey: 'k',
  cacheHit: 'local',
  provider: null,
  cacheSkipped: false,
  prebuild: null,
  outcome: 'hit',
  expectedMs: null,
  basis: 0,
});

function server() {
  const calls: string[] = [];
  const waiting: (() => void)[] = [];
  const request = (workspace: string, platform: Platform) => {
    calls.push(`${workspace} ${platform}`);
    return new Promise<BuildPlan>((resolve) => waiting.push(() => resolve(plan(platform))));
  };
  const answer = async () => {
    waiting.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { calls, waiting, request, answer };
}

describe('PlanChecks', () => {
  it('asks one plan at a time per workspace and reuses a fresh result for the same build', async () => {
    const mac = server();
    let now = 0;
    const checks = new PlanChecks(mac.request, () => now);
    checks.check('/w', { ios: 'a', android: 'b' });
    checks.check('/w', { ios: 'a', android: 'b' });
    checks.check('/other', { ios: 'c' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mac.calls).toEqual(['/w ios', '/other ios']);
    await mac.answer();
    expect(mac.calls).toEqual(['/w ios', '/other ios', '/w android']);
    await mac.answer();
    await mac.answer();
    expect(PlanChecks.state(checks.snapshot(), '/w', 'android')).toEqual({ kind: 'done', plan: plan('android') });

    now += PLAN_FRESH_MS - 1;
    checks.check('/w', { ios: 'a', android: 'b' });
    expect(mac.calls).toHaveLength(3);

    checks.check('/w', { ios: 'a2', android: 'b' });
    now += 2;
    checks.check('/w', { android: 'b' });
    expect(PlanChecks.state(checks.snapshot(), '/w', 'ios')).toEqual({ kind: 'checking' });
    await mac.answer();
    await mac.answer();
    expect(mac.calls).toEqual(['/w ios', '/other ios', '/w android', '/w ios', '/w android']);
  });

  it('ignores the reply of a cancelled check and lets the next one run after it', async () => {
    const mac = server();
    const checks = new PlanChecks(mac.request);
    checks.check('/w', { ios: 'a', android: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    checks.cancel('/w');
    expect(PlanChecks.state(checks.snapshot(), '/w', 'ios')).toBeUndefined();

    checks.check('/w', { ios: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mac.calls).toEqual(['/w ios']);
    await mac.answer();
    expect(PlanChecks.state(checks.snapshot(), '/w', 'ios')).toEqual({ kind: 'checking' });
    await mac.answer();
    expect(mac.calls).toEqual(['/w ios', '/w ios']);
    expect(PlanChecks.state(checks.snapshot(), '/w', 'ios')).toEqual({ kind: 'done', plan: plan('ios') });
  });
});
