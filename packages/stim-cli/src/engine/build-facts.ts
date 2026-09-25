export type CacheHitLevel = 'local' | 'remote' | false;

type LaunchStatus = boolean | 'unverified' | 'bundling';

export interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

interface LogsInfo {
  dir?: string;
}

export interface CompilationCacheActivity {
  status: 'reported' | 'unavailable' | 'not-run';
  hits: number | null;
  cacheableTasks: number | null;
  hitRatePercent: number | null;
  swiftTargetsWithoutExplicitModules?: number;
}

export interface CcacheActivity {
  status: 'reported' | 'unavailable' | 'not-run';
  hits: number | null;
  misses: number | null;
  hitRatePercent: number | null;
}

export interface DevServerStart {
  started: true;
  reason: 'not running' | 'stopped (idle)';
}

interface RunLeaseFacts {
  kind: string;
  expiresAt: string;
}

export interface IosFacts {
  slot?: string;
  platform: string;
  udid: string;
  deviceName: string | null;
  deviceType: string | null;
  runtime: string | null;
  fingerprint?: string | null;
  configuration: string | null;
  scheme?: string;
  cacheKey?: string | null;
  cacheHit: CacheHitLevel;
  cacheSkipped: boolean;
  compilationCache: CompilationCacheActivity;
  waitedForBuild: { pid: number | null; ms: number } | null;
  appPath?: string | null;
  bundleId?: string | null;
  installSkipped: boolean;
  launched: LaunchStatus;
  metroPort?: number | null;
  logs: LogsInfo;
  durationMs?: number;
  webPreviewUrl?: string | null;
  lease?: RunLeaseFacts | null;
  devServer?: DevServerStart;
}

export interface AndroidFacts {
  slot?: string;
  platform: string;
  serial: string | null;
  avdName: string | null;
  deviceName: string | null;
  systemImage: string | null;
  fingerprint: string | null;
  cacheKey: string | null;
  variant: string | null;
  metroPort: number | null;
  cacheHit: CacheHitLevel;
  cacheSkipped: boolean;
  waitedForBuild: { pid: number | null; ms: number } | null;
  appPath: string | null;
  bundleId: string | null;
  installSkipped: boolean;
  launched: LaunchStatus;
  ccache: CcacheActivity;
  debugHttpHost: string | null;
  debugHttpHostNote: string | null;
  devClientUrl: string | null;
  logs: string | null;
  durationMs: number | null;
  lease?: RunLeaseFacts | null;
  devServer?: DevServerStart;
}
