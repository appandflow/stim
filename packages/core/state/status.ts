import type { IdleStopRecord } from './workspace-state.ts';
export type StatsPlatform = 'ios' | 'android';

export type RunOutcomeKind = 'hit' | 'cold';

export const BUILD_PHASES = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'install',
  'launch',
] as const;

export type BuildPhase = (typeof BUILD_PHASES)[number];

export type ActiveBuildState = 'running' | 'stale' | 'unknown';

export interface BuildReport {
  platform: StatsPlatform;
  slot: string;
  state: ActiveBuildState;
  phase: BuildPhase;
  startedAt: string;
  phaseStartedAt: string;
  outcome: RunOutcomeKind | null;
  expectedMs: number | null;
  expectedPhaseMs: number | null;
  basis: number;
}

/** Where a build's app came from: a cache tier, or `false` when it compiled or failed before one was found. */
export type BuildCacheHit = 'local' | 'remote' | false;

/** A platform's most recent `ios` or `android` run in one workspace. */
export interface LastBuildReport {
  platform: StatsPlatform;
  status: 'ok' | 'failed';
  cacheHit: BuildCacheHit;
  cacheSkipped: boolean;
  durationMs: number | null;
  fingerprint: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode?: string;
}

/** The payload `stim ios --plan --json` and `stim android --plan --json` print. */
export interface BuildPlanPayload {
  platform: StatsPlatform;
  slot?: string;
  fingerprint: string;
  cacheKey: string | null;
  cacheHit: BuildCacheHit;
  provider: string | null;
  cacheSkipped: boolean;
  prebuild: 'none' | 'generate' | 'regenerate' | 'refuse' | null;
  outcome: RunOutcomeKind | null;
  expectedMs: number | null;
  basis: number;
  refusal?: { code: string; message: string; remedy: string };
}

type ActivityState = 'driven' | 'active' | 'idle' | 'unknown';

export interface ActivityDriver {
  tool: string;
  pid: number | null;
  since: string | null;
}

export interface DeviceActivity {
  state: ActivityState;
  driver?: ActivityDriver;
  lastActivityAt?: string;
  basis: string[];
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  repository?: string;
}

export interface AndroidRuntimeFacts {
  serial: string | null;
  state: 'detected' | 'not-detected' | 'missing' | 'unknown';
  error?: string;
}

export interface RemoteDeviceState {
  platform: 'ios' | 'android' | null;
  backend: 'eas';
  sessionId: string;
  state: 'claimed' | 'unclaimed' | 'unknown';
  startedAt: string | null;
  webPreviewUrl: string | null;
}

export interface EnvironmentState {
  slots?: { slot: string; ios: EnvironmentState['ios']; android: EnvironmentState['android'] }[];
  path: string;
  live: boolean;
  memoryMb: number;
  warnings: string[];
  ios?: { name: string | null; udid: string; owned: boolean; state: string; activity?: DeviceActivity } | null;
  android?: {
    name: string | undefined;
    owned: boolean;
    physical: boolean;
    serial?: string | null;
    state?: AndroidRuntimeFacts['state'];
    activity?: DeviceActivity;
  } | null;
  metro?: { port: number; running: boolean; pid: number | null; idleStop?: IdleStopRecord } | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  build?: BuildReport | null;
  lastBuilds?: Partial<Record<StatsPlatform, LastBuildReport>>;
}

export interface StatusCapacity {
  liveCount: number;
  committedMb: number;
  totalMemoryMb: number;
  overCapacity: boolean;
}

export interface DeviceLeaseState {
  slot?: string;
  path: string;
  platform: string;
  id: string | null;
  deviceName: string | null;
  holder: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  mine: boolean;
  expired: boolean;
  parsed: boolean;
}

/** The payload `stim status --json` prints, and `status --watch --json` prints on each change. */
export interface StatusPayload {
  environments: (EnvironmentState & { labelOnly?: true })[];
  capacity: StatusCapacity;
  deviceLeases: DeviceLeaseState[];
  unprovisionedWorktrees: WorktreeFacts[];
  simctlAvailable: boolean;
}
