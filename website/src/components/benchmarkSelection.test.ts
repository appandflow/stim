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
import { benchmarks, linkedBenchmarks } from './benchmarkCatalog';

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

  it('publishes only one benchmark per model, platform and scenario, and one run per arm and variant', () => {
    const dimensions = benchmarks.map((candidate) => JSON.stringify(benchmarkDimensions(candidate)));
    expect(new Set(dimensions).size).toBe(dimensions.length);
    for (const entry of linkedBenchmarks) {
      const cells = entry.runs.map((run) => `${run.arm}:${run.variant}`);
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it('publishes readiness-aware first-command error evidence for every launch-error Stim cell', () => {
    for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol', 'sonnet', 'opus']) {
      for (const platform of benchmarkPlatforms) {
        const entry = exactBenchmarkForDimensions(benchmarks, { model, platform, suite: 'launch-crash' });
        const stim = entry?.runs.find((run) => run.arm === 'stim');
        const control = entry?.runs.find((run) => run.arm === 'control');
        expect(stim).toMatchObject({ valid: true, appReadinessLogs: true });
        expect(control).toMatchObject({ valid: true, appReadinessLogs: false });
        const initial = stim?.commands.find((command) => command.id === stim.launchCrashAudit?.initialLaunchCommandId);
        expect(initial?.output).toMatch(/readiness\s+waiting/);
        expect(initial?.output).toMatch(/fingerprint .*hit/);
        expect(initial?.output).toContain('STIM_BENCH_LAUNCH_CRASH_');
      }
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

  it('routes the earlier Sol deep link to its current comparison', () => {
    const selection = { stage: 'sol-launch-crash', runId: 'launch-crash-stim' };
    const search = benchmarkSelectionSearch(selection, linkedBenchmarks);
    expect(benchmarkSelectionFromSearch(search, linkedBenchmarks)).toEqual({
      stage: 'sol-ios-launch-error',
      runId: 'launch-crash-stim',
    });
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
