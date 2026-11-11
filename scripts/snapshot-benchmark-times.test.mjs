import { describe, it, expect } from 'vitest';
import { campaignTimings } from './snapshot-benchmark-times.mjs';
import { benchmarkMatrix } from './agent-benchmark/matrix.mjs';

const VARIANT = { launch: 'javascript', 'native-change': 'native', 'error-fix': 'launch-crash' };
const MODEL = 'claude-sonnet-5-5';

const NATIVE_PLATFORMS = {
  macos: ['macos', 'native-swiftpm'],
  'native-ios': ['ios', 'native-xcode'],
  'native-android': ['android', 'native-gradle'],
  'exact-ios': ['ios', 'exact'],
};

function complete() {
  const cells = benchmarkMatrix().filter((cell) => cell.status !== 'unsupported');
  const readiness = (fixture) => ({
    primaryMetric: 'First recorded agent activity to validated Settings screenshot',
    fixture,
    runs: cells
      .filter((cell) => cell.platform.startsWith(fixture === 'bare' ? 'bare-' : 'expo-'))
      .map((cell) => ({
        model: MODEL,
        platform: cell.platform.split('-')[1],
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
  });
  const native = {
    pairs: cells
      .filter((cell) => NATIVE_PLATFORMS[cell.platform] && cell.arm === 'stim')
      .map((cell) => ({
        platform: NATIVE_PLATFORMS[cell.platform][0],
        backend: NATIVE_PLATFORMS[cell.platform][1],
        variant: cell.scenario === 'error-fix' ? 'launch-crash' : 'standalone',
        model: MODEL,
        runs: ['stim', 'control'].map((arm) => ({ arm, taskSeconds: 300 })),
      })),
  };
  return [readiness('trailhead'), readiness('bare'), native];
}

describe('campaign timing snapshot', () => {
  it('covers exactly the cells the matrix lists, keeping only timings and identities', () => {
    const datasets = complete();
    const result = campaignTimings('rc', datasets);
    expect(result.runs).toHaveLength(46);
    expect(result.runs.filter((run) => run.platform === 'exact-ios' && run.scenario === 'error-fix')).toEqual([
      expect.objectContaining({ timingOrigin: 'dispatch-to-completed-task', seconds: 300 }),
      expect.objectContaining({ timingOrigin: 'dispatch-to-completed-task', seconds: 300 }),
    ]);
    expect(result.runs.find((run) => run.scenario === 'error-fix').diagnosisSeconds).toBe(42);
    expect(result.runs.some((run) => run.platform === 'web')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|tokens|Cost|commands/);
    datasets[0].runs.reverse();
    datasets[2].pairs.reverse();
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
      { arm: 'expo-agent-cli', variant: 'native' },
    ]) {
      const bad = complete();
      Object.assign(
        bad[1].runs.find((run) => run.arm === 'stim'),
        change,
      );
      expect(() => campaignTimings('x', bad)).toThrow(/campaign cell|valid timings|Duplicate/);
    }
    const wrongMetric = complete();
    wrongMetric[0].primaryMetric = 'Dispatch to screen';
    expect(() => campaignTimings('x', wrongMetric)).toThrow('first-activity');
  });
});
