import type {
  BuildPlanPayload,
  MacosBuildPlanPayload,
  MacosBuild,
  NdjsonRecord,
  SettingsPayload,
  SettingScope,
  SettingWriteResult,
  StatsReport,
} from '@stim-cli/core/state';
import type { AndroidBuildFacts, AndroidBuildOptions } from '../commands/android/build.ts';
import type { MacosBuildFacts, MacosBuildOptions } from '../commands/macos-build.ts';
import type { IosBuildFacts, IosBuildOptions } from '../commands/ios/build.ts';
import type { StopResult } from '../commands/stop.ts';
import type { WebFacts } from '../commands/web.ts';
import type { AndroidFacts, IosFacts } from '../engine/build-facts.ts';
import type { DoctorReport } from '../commands/doctor.ts';
import type { GcPayload, GcReadOptions } from '../commands/gc.ts';
import type { ReloadFacts, ReloadPlatform } from '../commands/reload.ts';
import type { StartFacts } from '../supervisor/start-facts.ts';
import type { PlatformRunOptions } from '@stim-cli/core/protocol';

export type StimPlatform = 'ios' | 'android' | 'macos' | 'web';

export interface StimProgress {
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface StimOptions {
  /** Absolute or relative path to the app directory, resolved once when creating the client. */
  projectRoot: string;
  /** Absolute Stim state directory. Omit to use STIM_HOME from `env` or the default home. */
  home?: string;
  /** Environment Stim reads its settings overrides from and passes to its child processes. Defaults to the caller's `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Absolute native artifact cache directory. Its coordinating home must be shared by all writers. */
  buildCache?: string;
  /**
   * Receives output chunks without writing to the importing process's terminal.
   * An exception cancels the operation and rejects it with that exception.
   */
  onProgress?: (event: StimProgress) => void;
}

export type StimRunOptions = PlatformRunOptions & { signal?: AbortSignal };

export type StimRunResult =
  | { platform: 'ios'; facts: IosFacts }
  | { platform: 'android'; facts: AndroidFacts }
  | {
      platform: 'macos';
      facts: {
        product: string;
        bundle: string;
        bundleId: string;
        executable: string;
        pid: number | null;
        launched: boolean | 'unverified';
        build: MacosBuild;
        logs: { dir: string };
      };
    }
  | { platform: 'web'; facts: WebFacts };

export type StimBuildOptions = (
  | (IosBuildOptions & { platform: 'ios' })
  | (AndroidBuildOptions & { platform: 'android' })
  | (MacosBuildOptions & { platform: 'macos' })
) & { signal?: AbortSignal };

export type StimBuildResult =
  | { platform: 'ios'; facts: IosBuildFacts }
  | { platform: 'android'; facts: AndroidBuildFacts }
  | { platform: 'macos'; facts: MacosBuildFacts };

export interface StimStopOptions {
  slot?: string;
  signal?: AbortSignal;
  /** Runs once with the resolved workspace before teardown; throwing refuses the operation. */
  beforeStop?: (workspace: string) => void;
}

export type StimStopResult = StopResult;

export interface StimStartOptions {
  remote?: boolean;
  resetCache?: boolean;
  waitSeconds?: number;
  signal?: AbortSignal;
  /** Runs once with the resolved app before usage recording or startup; throwing refuses the operation. */
  beforeStart?: (workspace: string) => void;
}

export type StimStartResult = StartFacts;

export interface StimReloadOptions {
  platform?: ReloadPlatform;
  signal?: AbortSignal;
  /** Runs once with the resolved workspace before usage recording or a reload; throwing refuses the operation. */
  beforeReload?: (workspace: string) => void;
}

export type StimReloadResult = ReloadFacts;

export interface StimDiagnosticsOptions {
  /** Maximum number of records, default 200. Zero returns paths without records. */
  tail?: number;
  errors?: boolean;
  signal?: AbortSignal;
}

export interface StimDiagnostics {
  directory: string;
  records: NdjsonRecord[];
}

export interface StimLogsOptions {
  slot?: string;
  sources?: string[];
  minLevel?: string;
  since?: string;
  grep?: string;
  tail?: number;
  errorsOnly?: boolean;
  signal?: AbortSignal;
}

export interface StimReadOptions {
  signal?: AbortSignal;
}

export type StimPlanOptions = ({ platform: 'ios' | 'android'; slot?: string } | { platform: 'macos' }) &
  StimReadOptions;

export type StimPlan = BuildPlanPayload | MacosBuildPlanPayload;

export interface StimDoctorOptions extends StimReadOptions {
  platform?: 'ios' | 'android';
  /** Records completed iOS/Android checks in project state. Defaults to false for report-only reads. */
  record?: boolean;
}

export type StimDoctorReport = DoctorReport;
export type StimGcOptions = GcReadOptions & StimReadOptions;
export type StimGcReport = Exclude<GcPayload, { code: string }>;

export type StimSettings = SettingsPayload;
export type StimSettingWriteResult = SettingWriteResult;

export interface StimSettingWriteOptions extends StimReadOptions {
  scope?: SettingScope;
  /** Runs once with the resolved workspace before mutation; throwing refuses the write. */
  beforeWrite?: (workspace: string | null) => void;
}

export type StimStats = StatsReport;

export interface StimClient {
  readonly projectRoot: string;
  /** Starts or reuses the app's dev server; resources remain workspace-owned until stop is called. */
  start(options?: StimStartOptions): Promise<StimStartResult>;
  /** Returns this home's persistent nonsecret identity, initializing it under the config lock on first use. */
  identity(options?: StimReadOptions): Promise<string>;
  /** Reads findings with a 60 second execution and 35 second cleanup budget. Never repairs; records a completed check only with `record: true`. */
  doctor(options?: StimDoctorOptions): Promise<StimDoctorReport>;
  /** Predicts the configured native build with a 60 second execution and 35 second cleanup budget; never builds or launches. */
  plan(options: StimPlanOptions): Promise<StimPlan>;
  /** Reads the GC dry-run report with a 60 second execution and 35 second cleanup budget. Never deletes, repairs or shuts down idle resources. */
  gc(options?: StimGcOptions): Promise<StimGcReport>;
  /** Builds an artifact without acquiring a device or starting a runtime. */
  build<P extends StimBuildOptions['platform']>(
    options: StimBuildOptions & { platform: P },
  ): Promise<Extract<StimBuildResult, { platform: P }>>;
  build(options: StimBuildOptions): Promise<StimBuildResult>;
  run<P extends StimPlatform>(
    options: StimRunOptions & { platform: P },
  ): Promise<Extract<StimRunResult, { platform: P }>>;
  run(options: StimRunOptions): Promise<StimRunResult>;
  /** Stops this workspace, including resources created before a failed run. Use a fresh signal for cleanup. */
  stop(options?: StimStopOptions): Promise<StimStopResult>;
  /** Requests a JavaScript or owned Chrome reload. Completion is not observed; cancellation cannot undo a sent request. */
  reload(options?: StimReloadOptions): Promise<StimReloadResult>;
  /** Reads the existing local timeline in process; available even when run failed before creating any logs. */
  diagnostics(options?: StimDiagnosticsOptions): Promise<StimDiagnostics>;
  /**
   * Every setting with its effective value, origin and per-layer values for this project, as `stim settings --json`
   * prints them. Runs in the calling process without blocking its event loop on child processes.
   */
  settings(options?: StimReadOptions): Promise<StimSettings>;
  /** Writes CLI text (including JSON for object/array settings) to one layer; returned sensitive values are masked. */
  setSetting(key: string, value: string, options?: StimSettingWriteOptions): Promise<StimSettingWriteResult>;
  /** Removes one layer value. Cancellation prevents a pending write; committed writes finish recording cleanup. */
  unsetSetting(key: string, options?: StimSettingWriteOptions): Promise<StimSettingWriteResult>;
  /**
   * Run and build-cache counts for this project and machine, build placement and the last recorded agent-device and
   * SwiftPM cache usage, as `stim stats --json` prints them except that the usage figures are not measured again.
   * Runs in the calling process without blocking its event loop on child processes.
   */
  stats(options?: StimReadOptions): Promise<StimStats>;
  /** Reads the merged raw log timeline, including native crashes and agent actions, as `stim logs --json`. */
  logs(options?: StimLogsOptions): Promise<NdjsonRecord[]>;
  /** Emits backfill, then appended records until stopped or aborted. With onBackfill, initial batches are awaited there instead. */
  followLogs(
    options: StimLogsOptions,
    onRecord: (record: NdjsonRecord) => void,
    onBackfill?: (records: readonly NdjsonRecord[]) => Promise<void>,
  ): Promise<() => void>;
}

export interface StimFailure {
  code: string;
  message: string;
  remedy: string | null;
  details?: unknown;
}
