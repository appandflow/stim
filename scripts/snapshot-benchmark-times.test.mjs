import { describe, it, expect } from 'vitest';
import { campaignTimings } from './snapshot-benchmark-times.mjs';

function complete() {
  return [
    {
      primaryMetric: 'First recorded agent activity to validated Settings screenshot',
      runs: ['gpt-5.6-luna', 'gpt-5.6-sol', 'sonnet', 'opus'].flatMap((model) =>
        ['ios', 'android'].flatMap((platform) =>
          ['javascript', 'native', 'launch-crash'].flatMap((variant) =>
            ['stim', 'control'].map((arm) => ({
              model,
              platform,
              variant,
              arm,
              valid: true,
              settingsReadySeconds: 123.456,
              diagnosisSeconds: 42,
              commands: ['private'],
              usage: { input_tokens: 999 },
              proof: '/private/path',
              estimatedTokenCostUsd: 1,
            })),
          ),
        ),
      ),
    },
  ];
}

describe('campaign timing snapshot', () => {
  it('keeps only normalized timings and identities, independent of dataset ordering', () => {
    const datasets = complete();
    const result = campaignTimings('rc', datasets);
    expect(result.runs).toHaveLength(48);
    expect(result.runs[0]).toEqual({
      model: 'gpt-5.6-luna',
      platform: 'android',
      scenario: 'javascript',
      arm: 'control',
      settingsReadySeconds: 123.456,
    });
    expect(result.runs.find((run) => run.scenario === 'launch-crash').diagnosisSeconds).toBe(42);
    expect(JSON.stringify(result)).not.toMatch(/private|tokens|Cost|commands/);
    datasets[0].runs.reverse();
    expect(campaignTimings('rc', datasets)).toEqual(result);
  });
  it('rejects partial, duplicated, invalid, or unnormalized campaigns', () => {
    const partial = complete();
    partial[0].runs.pop();
    expect(() => campaignTimings('x', partial)).toThrow('Incomplete');
    const duplicate = complete();
    duplicate[0].runs[0] = duplicate[0].runs[1];
    expect(() => campaignTimings('x', duplicate)).toThrow('Duplicate');
    for (const change of [
      { valid: false },
      { settingsReadySeconds: null },
      { settingsReadySeconds: -1 },
      { model: 'unknown' },
    ]) {
      const invalid = complete();
      Object.assign(invalid[0].runs[0], change);
      expect(() => campaignTimings('x', invalid)).toThrow(/valid timings|Unexpected/);
    }
    const missingDiagnosis = complete();
    missingDiagnosis[0].runs.find((run) => run.variant === 'launch-crash').diagnosisSeconds = null;
    expect(() => campaignTimings('x', missingDiagnosis)).toThrow('valid timings');
    const dispatch = complete();
    dispatch[0].primaryMetric = 'dispatch';
    expect(() => campaignTimings('x', dispatch)).toThrow('first-activity');
  });
  it('recognizes legacy iOS datasets only when their simulator metadata confirms the platform', () => {
    const datasets = complete();
    datasets[0].runs.find((run) => run.platform === 'ios').platform = undefined;
    expect(() => campaignTimings('rc', datasets)).toThrow('Unexpected');
    datasets[0].environment = { simulator: 'iPhone 17 / iOS 26.5' };
    expect(campaignTimings('rc', datasets).runs).toHaveLength(48);
  });
});
