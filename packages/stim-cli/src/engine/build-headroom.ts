import type { BuildLedgerPlatform, BuildLedgerRecord } from '@stim-cli/core/state';

const GB = 1024 ** 3;

export type BuildProjectType = 'expo' | 'react-native' | 'native' | 'exact';

/**
 * Bytes a cold local build of each project type writes when the project has no recorded build, in GB: its workspace
 * build output plus growth of the shared caches (artifact store, compilation cache, ccache, Gradle, Pods).
 * `react-native` covers bare React Native and Re.Pack; `native` covers standalone Xcode, Gradle and SwiftPM projects, the only macOS ones; an Exact app builds for iOS only.
 * Every figure is an estimate. The anchors measured on this machine on 2026-11-11 (dev-disk-audit): `ios/build` of
 * 1.1 to 1.6 GB and `android/app/build` of 0.9 to 5.1 GB for React Native apps and libraries, and a single-target
 * Cargo `target/` of 6.8 GB; a cold Expensify iOS build needed about 30 GB, the upper case. A project's own history
 * replaces its row after its first measured build.
 */
export const DEFAULT_BUILD_GB: Record<BuildProjectType, Partial<Record<BuildLedgerPlatform, number>>> = {
  expo: { ios: 6, android: 6 },
  'react-native': { ios: 8, android: 6 },
  native: { ios: 4, android: 3, macos: 2 },
  exact: { ios: 20 },
};

/** Recorded builds older than this no longer inform an estimate. */
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** The newest matching records an estimate takes its median from. */
const HISTORY_LIMIT = 10;

export interface BuildEstimate {
  bytes: number;
  source: 'history' | 'default';
}

/**
 * The bytes the next cold local build of `projectKey` on `platform` is expected to write: the median of the
 * `HISTORY_LIMIT` newest positive `bytesWritten` of its succeeded, non-hit builds in the last 30 days, else the
 * default for its type.
 */
export function estimateBuildBytes({
  records,
  projectKey,
  platform,
  type,
  now,
}: {
  records: readonly BuildLedgerRecord[];
  projectKey: string;
  platform: BuildLedgerPlatform;
  type: BuildProjectType;
  now: number;
}): BuildEstimate {
  const recorded = records
    .filter((record) => record.projectKey === projectKey && record.platform === platform)
    .filter(
      (record) =>
        record.outcome === 'succeeded' && record.cache.result !== 'hit' && now - record.ts <= HISTORY_MAX_AGE_MS,
    )
    .toSorted((a, b) => b.ts - a.ts)
    .flatMap((record) =>
      typeof record.bytesWritten === 'number' && record.bytesWritten > 0 ? [record.bytesWritten] : [],
    )
    .slice(0, HISTORY_LIMIT)
    .toSorted((a, b) => a - b);
  if (recorded.length) {
    const middle = Math.floor(recorded.length / 2);
    const median = recorded.length % 2 ? recorded[middle] : ((recorded[middle - 1] ?? 0) + (recorded[middle] ?? 0)) / 2;
    return { bytes: median ?? 0, source: 'history' };
  }
  return {
    bytes: (DEFAULT_BUILD_GB[type][platform] ?? DEFAULT_BUILD_GB.native[platform] ?? 0) * GB,
    source: 'default',
  };
}
