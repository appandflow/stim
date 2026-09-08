import type { BenchmarkData, BenchmarkRun } from './benchmarkData';
export { defaultRun } from './benchmarkSelection';
import benchmarkJson from '../data/benchmarks/luna-rc12.json';
import lunaAndroidBenchmarkJson from '../data/benchmarks/luna-android.json';
import opusBenchmarkJson from '../data/benchmarks/opus-rc12.json';
import opusAndroidBenchmarkJson from '../data/benchmarks/opus-android.json';
import sonnetBenchmarkJson from '../data/benchmarks/sonnet-rc12.json';
import sonnetAndroidBenchmarkJson from '../data/benchmarks/sonnet-android.json';
import solBenchmarkJson from '../data/benchmarks/sol-rc12.json';
import solAndroidBenchmarkJson from '../data/benchmarks/sol-android.json';
import solLaunchCrashJson from '../data/benchmarks/sol-launch-crash.json';
import lunaIosLaunchError from '../data/benchmarks/luna-ios-launch-error.json';
import lunaAndroidLaunchError from '../data/benchmarks/luna-android-launch-error.json';
import solIosLaunchError from '../data/benchmarks/sol-ios-launch-error.json';
import solAndroidLaunchError from '../data/benchmarks/sol-android-launch-error.json';
import sonnetIosLaunchError from '../data/benchmarks/sonnet-ios-launch-error.json';
import sonnetAndroidLaunchError from '../data/benchmarks/sonnet-android-launch-error.json';
import opusIosLaunchError from '../data/benchmarks/opus-ios-launch-error.json';
import opusAndroidLaunchError from '../data/benchmarks/opus-android-launch-error.json';

export const benchmarks = (
  [
    benchmarkJson,
    lunaAndroidBenchmarkJson,
    solBenchmarkJson,
    solAndroidBenchmarkJson,
    sonnetBenchmarkJson,
    sonnetAndroidBenchmarkJson,
    opusBenchmarkJson,
    opusAndroidBenchmarkJson,
    lunaIosLaunchError,
    lunaAndroidLaunchError,
    solIosLaunchError,
    solAndroidLaunchError,
    sonnetIosLaunchError,
    sonnetAndroidLaunchError,
    opusIosLaunchError,
    opusAndroidLaunchError,
  ] as BenchmarkData[]
).filter((benchmark) => benchmark.runs.some((run) => run.valid));

export const linkedBenchmarks = [...benchmarks, solLaunchCrashJson as BenchmarkData];

export function displayVariant(variant: BenchmarkRun['variant']): string {
  if (variant === 'javascript') return 'JavaScript change';
  if (variant === 'native') return 'Native change';
  return 'JavaScript launch failure';
}
