import type { BuildMissReason } from '@stim-cli/core/state';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import type { LaunchErrorRecord } from '../../command-output.ts';
import type { LeaseFacts } from '../../engine/device-lease-run.ts';

export interface DeviceLike {
  deviceName?: string | null;
  name?: string | null;
  avdName?: string | null;
  deviceType?: string | null;
  runtime?: string | null;
  adopted?: boolean;
  adoptionPending?: boolean;
  parkedCacheKey?: string;
}

export interface IosBootLike {
  ok?: boolean;
  failed?: boolean;
  udid?: string;
  reason?: string;
  code?: string;
  remedy?: string;
}

export interface PodStateLike {
  hasPodfile?: boolean;
  lockText?: unknown;
  manifestText?: unknown;
}

export interface PodVerdictLike {
  stale?: boolean;
  reason?: string;
  noPods?: boolean;
}

export interface RemoteUploadLike {
  uploaded?: boolean;
  timedOut?: boolean;
  failed?: string | null;
}

export interface VerifyLaunchResultLike {
  record?: Record<string, unknown>;
  readiness?: 'ready' | 'timed-out' | 'error';
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  unattributed?: boolean;
  fatal?: boolean;
  processAlive?: boolean | null;
  errors?: LaunchErrorRecord[];
  waitedMs?: number;
}

export interface IosCommandOptions {
  slot?: string;
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  configuration?: string;
  scheme?: string;
  easProfile?: string;
  deviceType?: string;
  runtime?: string;
  simulatorApp?: string;
  device?: string | boolean;
  remote?: RemoteDeviceBackend;
  wait?: string | boolean;
  waitConflict?: boolean;
  plan?: boolean;
}

export interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

export interface FailArgs {
  code: string;
  message?: string | null;
  remedy?: string | null;
  lines?: string[];
  logPath?: string | null;
  build?: BuildFailureFields | null;
  lease?: LeaseFacts | null;
}

export interface BuildFailureFields {
  missReason?: BuildMissReason | null;
  diagnostics?: readonly unknown[] | null;
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
}
