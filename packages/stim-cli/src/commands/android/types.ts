import type { BuildMissReason } from '@stim-cli/core/state';
import type { LaunchErrorRecord } from '../../command-output.ts';
import type { LeaseFacts } from '../../engine/device-lease-run.ts';
import type { AndroidFacts } from '../../engine/build-facts.ts';
import type { createNdjsonWriter } from '../../ndjson.ts';

export interface RemoteUploadLike {
  uploaded?: boolean;
  timedOut?: boolean;
  failed?: string | null;
}

export interface PrebuildResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  lastLines?: string[];
  durationMs?: number;
}

export interface InstallResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  note?: string;
  skipped?: boolean;
}

export interface LaunchResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientNote?: string | null;
  devClientUrl?: string;
  jsLocation?: string;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
}

export interface VerifyLaunchResultLike {
  record?: Record<string, unknown>;
  readiness?: 'ready' | 'timed-out' | 'error';
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  fatal?: boolean;
  processAlive?: boolean | null;
  errors?: LaunchErrorRecord[];
  waitedMs?: number;
}

export interface FailExtra {
  lastBuildStatus?: boolean;
  diagnostics?: string[];
  lines?: string[];
  logPath?: string | null;
  lease?: LeaseFacts | null;
}

export interface AndroidRecord {
  missReason?: BuildMissReason | null;
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
  systemImage?: string | null;
}

export interface RunAndroidResult {
  ok: boolean;
  error?: { code?: string; message?: string | null; remedy?: string | null };
  facts?: AndroidFacts;
}

export interface AndroidBootLike {
  ok?: boolean;
  failed?: boolean;
  serial?: string;
  reason?: string;
  code?: string;
  remedy?: string;
}

export type AndroidWriter = ReturnType<typeof createNdjsonWriter>;
