import { describe, it, expect } from 'vitest';
import { campaignTimings } from './snapshot-benchmark-times.mjs';
import { benchmarkMatrix } from './agent-benchmark/matrix.mjs';

const VARIANT = { launch: 'javascript', 'native-change': 'native', 'error-fix': 'launch-crash' };
const MODEL = 'claude-sonnet-5-5';

function complete() {
  return [
    {
      primaryMetric: 'First recorded agent activity to validated Settings screenshot',
      runs: benchmarkMatrix()
        .filter((cell) => cell.status !== 'unsupported')
        .map((cell) => ({
          model: MODEL,
          matrixPlatform: cell.platform,
          variant: VARIANT[cell.scenario],
          arm: cell.arm,
          valid: true,
          settingsReadySeconds: 123.456,
          diagnosisSeconds: 42,
          commands: ['private'],
          usage: { input_tokens: 999 },
          proof: '/private/path',
          estimatedTokenCostUsd: 1,
        })),
    },
  ];
}

describe('campaign timing snapshot', () => {
  it('covers exactly the cells the matrix lists, keeping only timings and identities', () => {
    const datasets = complete();
    const result = campaignTimings('rc', datasets);
    expect(result.runs).toHaveLength(datasets[0].runs.length);
    expect(result.runs.find((run) => run.scenario === 'error-fix').diagnosisSeconds).toBe(42);
    expect(result.runs.some((run) => run.platform === 'web')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|tokens|Cost|commands/);
    datasets[0].runs.reverse();
    expect(campaignTimings('rc', datasets)).toEqual(result);
  });

  it('rejects partial, duplicated, invalid or off-matrix campaigns', () => {
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
      { matrixPlatform: 'web' },
      { arm: 'expo-agent-cli', matrixPlatform: 'native-ios' },
    ]) {
      const bad = complete();
      Object.assign(bad[0].runs[0], change);
      expect(() => campaignTimings('x', bad)).toThrow(/campaign cell|valid timings|Duplicate/);
    }
    const wrongMetric = complete();
    wrongMetric[0].primaryMetric = 'Dispatch to screen';
    expect(() => campaignTimings('x', wrongMetric)).toThrow('first-activity');
  });
});
