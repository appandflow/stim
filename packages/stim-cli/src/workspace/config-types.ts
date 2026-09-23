import type { SettingsObject } from './settings-types.ts';

export interface SupervisorRecord {
  processToken?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  serverPid?: number;
  serverProcessToken?: string;
  mode?: string;
  [key: string]: unknown;
}

interface IosDeviceRecord {
  deviceUdid?: string;
  deviceName?: string | null;
  owned?: boolean;
  serial?: string;
  simslimManaged?: boolean;
  [key: string]: unknown;
}

interface AndroidDeviceRecord {
  avdName?: string;
  consolePort?: number;
  serial?: string;
  kind?: string;
  deviceName?: string | null;
  owned?: boolean;
  setupIncomplete?: boolean;
  [key: string]: unknown;
}

export type DeviceRecord = IosDeviceRecord | AndroidDeviceRecord;

export interface PlatformRecords {
  ios?: IosDeviceRecord;
  android?: AndroidDeviceRecord;
  [platform: string]: DeviceRecord | undefined;
}

export interface ProjectRecord {
  ports?: Record<string, number>;
  metroPort?: number | null;
  platforms?: PlatformRecords;
  deviceSlots?: Record<string, PlatformRecords>;
  supervisor?: SupervisorRecord;
  settings?: SettingsObject;
  worktreeRoot?: boolean;
  worktreeBranch?: string;
  worktreeBranchOwned?: boolean;
  worktreeMainRoot?: string;
  worktreeRemovalComplete?: boolean;
  worktreePendingBranchSha?: string;
  label?: string;
  bundleId?: string;
  androidPackage?: string;
  isExpo?: boolean;
  lastBuild?: Record<string, unknown>;
  doctorRuns?: Partial<Record<'ios' | 'android', DoctorRunRecord>>;
  [key: string]: unknown;
}

export interface DoctorRunRecord {
  at: string;
  version: string;
}

export interface RepoRecord {
  settings?: SettingsObject;
  [key: string]: unknown;
}

export interface ConcurrencyLimits {
  maxBuilds: number;
  maxDevices: number;
}

export interface StimConfig {
  version?: number;
  projects: Record<string, ProjectRecord>;
  repos: Record<string, RepoRecord>;
  tempDir?: unknown;
  iosSimulatorApp?: unknown;
  optimizations?: unknown;
  concurrency?: { maxBuilds?: unknown; maxDevices?: unknown };
  pool?: { iosParkedMax?: unknown; androidParkedMax?: unknown };
  parked?: { ios?: unknown; android?: unknown };
  caches?: { buildCache?: unknown; metroCache?: unknown };
  [key: string]: unknown;
}
export type Config = StimConfig;
