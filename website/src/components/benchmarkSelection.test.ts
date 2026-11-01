import { describe, expect, it } from 'vitest';
import { exactBenchmarkForDimensions } from './benchmarkSelection';
import type { BenchmarkData } from './benchmarkData';
import { benchmarkSelectionFromSearch, benchmarkSelectionSearch } from './benchmarkData';
import { linkedBenchmarks } from './benchmarkCatalog';

function benchmark(
  stage: string,
  model: string,
  platform: 'ios' | 'android' | undefined,
  suite: 'readiness' | 'launch-crash' | undefined,
): BenchmarkData {
  return {
    stage,
    title: stage,
    platform,
    suite,
    pricing: model.startsWith('gpt-') ? { model } : null,
    environment: { simulator: platform === 'android' ? 'Android emulator' : 'iPhone Simulator' },
    runs: [
      { id: 'javascript-stim', arm: 'stim', variant: 'javascript', model, platform, valid: true },
      { id: 'native-stim', arm: 'stim', variant: 'native', model, platform, valid: true },
    ],
  } as BenchmarkData;
}

describe('benchmark catalog selection', () => {
  it('routes superseded readiness-check links to the current comparison and preserves the requested arm', () => {
    for (const model of ['sol', 'luna', 'sonnet', 'opus']) {
      const oldStage = `${model}-android-readiness-entry-${model === 'sonnet' ? 'retry' : 'error'}`;
      for (const arm of ['stim', 'control']) {
        const selection = benchmarkSelectionFromSearch(
          `?benchmark=${oldStage}&run=launch-crash-${arm}`,
          linkedBenchmarks,
        );
        expect(selection).toEqual({ stage: `${model}-android-launch-error`, runId: `launch-crash-${arm}` });
        expect(benchmarkSelectionSearch(selection, linkedBenchmarks)).toContain(`${model}-android-launch-error`);
      }
    }
  });

  const readinessIos = benchmark('sol-ios', 'gpt-5.6-sol', 'ios', 'readiness');
  const readinessAndroid = benchmark('sol-android', 'gpt-5.6-sol', 'android', 'readiness');
  const crashIos = benchmark('sol-crash', 'gpt-5.6-sol', 'ios', 'launch-crash');
  const lunaIos = benchmark('luna-ios', 'gpt-5.6-luna', undefined, undefined);
  const catalog = [lunaIos, readinessIos, readinessAndroid, crashIos];

  it('distinguishes an exact published combination from a fallback', () => {
    expect(
      exactBenchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'ios', suite: 'launch-crash' })?.stage,
    ).toBe('sol-crash');
    expect(
      exactBenchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'android', suite: 'launch-crash' }),
    ).toBeUndefined();
  });
});
