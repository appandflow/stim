export type SettingsObject = Record<string, unknown>;

export interface SupervisorRecord {
  processToken?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  serverPid?: number;
  mode?: string;
  [key: string]: unknown;
}

interface IosDeviceRecord {
  deviceUdid?: string;
  deviceName?: string | null;
  owned?: boolean;
  serial?: string;
  simslimManaged?: boolean;
  schemeApprovals?: string[];
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
  bootPending?: boolean;
  [key: string]: unknown;
}

export type DeviceRecord = IosDeviceRecord | AndroidDeviceRecord;

export interface PlatformRecords {
  ios?: IosDeviceRecord;
  android?: AndroidDeviceRecord;
  [platform: string]: DeviceRecord | undefined;
}

/**
 * The commands of a named port's server: `stop` stops it and keeps its data, `teardown` removes it with the workspace,
 * `resume` starts it again after an idle stop.
 */
export interface PortCommands {
  stop?: string[];
  teardown?: string[];
  resume?: string[];
}

export interface ProjectRecord {
  ports?: Record<string, number>;
  portCommands?: Record<string, PortCommands>;
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

export interface PlatformDeviceLimits {
  ios: number;
  android: number;
  macos: number;
}

export interface StimConfig {
  version?: number;
  homeId?: string;
  projects: Record<string, ProjectRecord>;
  repos: Record<string, RepoRecord>;
  tempDir?: unknown;
  iosSimulatorApp?: unknown;
  androidEmulatorApp?: unknown;
  optimizations?: unknown;
  concurrency?: {
    maxBuilds?: unknown;
    maxTests?: unknown;
    maxDevices?: unknown;
    maxIosDevices?: unknown;
    maxAndroidDevices?: unknown;
    maxMacosApps?: unknown;
  };
  pool?: { iosParkedMax?: unknown; androidParkedMax?: unknown; bootedGraceMinutes?: unknown };
  parked?: { ios?: unknown; android?: unknown };
  caches?: { buildCache?: unknown; metroCache?: unknown };
  hosting?: { agentDriver?: unknown };
  debug?: { logs?: unknown };
  daemon?: { mode?: unknown; attachedExitWaitSeconds?: unknown };
  engine?: { autoUpdate?: unknown };
  server?: {
    buildsPaused?: unknown;
    devicesPaused?: unknown;
    acceptClientBuilds?: unknown;
    keepAwake?: unknown;
    lanAddresses?: unknown;
    maxLoadPerCore?: unknown;
    maxOffloadedBuilds?: unknown;
    workerRoot?: unknown;
    workerAreaMaxAgeDays?: unknown;
  };
  share?: { exposure?: unknown; publicUrl?: unknown; port?: unknown };
  remote?: {
    machines?: unknown;
    easMaxDurationMinutes?: unknown;
    build?: unknown;
    buildPoolDisabled?: unknown;
    devicePoolDisabled?: unknown;
  };
  [key: string]: unknown;
}
export type Config = StimConfig;

const MACHINE_RECORDS = ['version', 'homeId', 'projects', 'repos', 'parked'] satisfies Array<keyof StimConfig & string>;

export const MACHINE_RECORD_KEYS: ReadonlySet<string> = new Set<string>(MACHINE_RECORDS);
