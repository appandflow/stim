import { describe, expect, it } from 'vitest';
import {
  benchmarkDimensions,
  benchmarkForDimensions,
  benchmarkModelLabel,
  benchmarkPlatforms,
  benchmarkSuites,
  defaultRun,
  exactBenchmarkForDimensions,
} from './benchmarkSelection';
import type { BenchmarkData } from './benchmarkData';
import { benchmarkSelectionFromSearch, benchmarkSelectionSearch } from './benchmarkData';
import { benchmarks, linkedBenchmarks, readinessIntegrationChecks } from './benchmarkCatalog';

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
      { id: 'javascript-stim', model, platform, valid: true },
      { id: 'native-stim', model, platform, valid: true },
    ],
  } as BenchmarkData;
}

describe('benchmark catalog selection', () => {
  it('deep-links Stim-only readiness checks without substituting them into matched comparisons', () => {
    expect(readinessIntegrationChecks).toHaveLength(4);
    for (const check of readinessIntegrationChecks) {
      expect(check.runs).toHaveLength(1);
      const run = check.runs[0];
      expect(run).toMatchObject({ valid: true, arm: 'stim', platform: 'android', variant: 'launch-crash' });
      const selection = { stage: check.stage, runId: run.id };
      expect(
        benchmarkSelectionFromSearch(benchmarkSelectionSearch(selection, linkedBenchmarks), linkedBenchmarks),
      ).toEqual(selection);
      const comparison = exactBenchmarkForDimensions(benchmarks, benchmarkDimensions(check));
      expect(comparison?.stage).not.toBe(check.stage);
      expect(comparison?.runs.map((candidate) => candidate.arm)).toEqual(['stim', 'control']);
    }
  });

  it('selects each published launch-error pair without choosing the earlier Sol sample', () => {
    for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol', 'sonnet', 'opus']) {
      for (const platform of benchmarkPlatforms) {
        const selected = exactBenchmarkForDimensions(benchmarks, { model, platform, suite: 'launch-crash' });
        const runs = selected?.runs.filter((run) => run.valid);
        expect(runs).toHaveLength(2);
        expect(runs?.map((run) => run.arm)).toEqual(expect.arrayContaining(['control', 'stim']));
        expect(selected?.stage).not.toBe('sol-launch-crash');
      }
    }
  });

  it('keeps the earlier Sol deep link reachable without duplicating its current comparison', () => {
    const selection = { stage: 'sol-launch-crash', runId: 'launch-crash-stim' };
    const search = benchmarkSelectionSearch(selection, linkedBenchmarks);
    expect(benchmarkSelectionFromSearch(search, linkedBenchmarks)).toEqual(selection);
    expect(
      benchmarks
        .filter((candidate) => {
          const dimensions = benchmarkDimensions(candidate);
          return (
            dimensions.model === 'gpt-5.6-sol' && dimensions.platform === 'ios' && dimensions.suite === 'launch-crash'
          );
        })
        .map((candidate) => candidate.stage),
    ).toEqual(['sol-ios-launch-error']);
  });
  const readinessIos = benchmark('sol-ios', 'gpt-5.6-sol', 'ios', 'readiness');
  const readinessAndroid = benchmark('sol-android', 'gpt-5.6-sol', 'android', 'readiness');
  const crashIos = benchmark('sol-crash', 'gpt-5.6-sol', 'ios', 'launch-crash');
  const lunaIos = benchmark('luna-ios', 'gpt-5.6-luna', undefined, undefined);
  const catalog = [lunaIos, readinessIos, readinessAndroid, crashIos];

  it('derives missing legacy dimensions from the run and environment', () => {
    expect(benchmarkDimensions(lunaIos)).toEqual({
      model: 'gpt-5.6-luna',
      platform: 'ios',
      suite: 'readiness',
    });
  });

  it('selects model, platform, and suite independently', () => {
    expect(
      benchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'ios', suite: 'launch-crash' })?.stage,
    ).toBe('sol-crash');
    expect(
      benchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'android', suite: 'launch-crash' })?.stage,
    ).toBe('sol-android');
  });

  it('distinguishes an exact published combination from a fallback', () => {
    expect(
      exactBenchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'ios', suite: 'launch-crash' })?.stage,
    ).toBe('sol-crash');
    expect(
      exactBenchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'android', suite: 'launch-crash' }),
    ).toBeUndefined();
  });

  it('keeps every known platform and scenario available to render', () => {
    expect(benchmarkPlatforms).toEqual(['ios', 'android']);
    expect(benchmarkSuites).toEqual(['readiness', 'launch-crash']);
  });

  it('preserves a run when the destination provides it', () => {
    expect(defaultRun(readinessAndroid, 'native-stim')?.id).toBe('native-stim');
    expect(defaultRun(readinessAndroid, 'missing')?.id).toBe('javascript-stim');
  });

  it('formats the catalog model identifiers for picker labels', () => {
    expect(benchmarkModelLabel('gpt-5.6-luna')).toBe('Luna');
    expect(benchmarkModelLabel('sonnet')).toBe('Sonnet');
  });
});
