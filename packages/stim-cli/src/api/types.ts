import type { MacosBuild, NdjsonRecord, SettingsPayload, StatsReport } from '@stim-cli/core/state';
import type { AndroidBuildFacts, AndroidBuildOptions } from '../commands/android/build.ts';
import type { MacosBuildFacts, MacosBuildOptions } from '../commands/macos-build.ts';
import type { IosBuildFacts, IosBuildOptions } from '../commands/ios/build.ts';
import type { StopResult } from '../commands/stop.ts';
import type { WebFacts } from '../commands/web.ts';
import type { AndroidFacts, IosFacts } from '../engine/build-facts.ts';

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
  /** Environment Stim reads its settings overrides from and passes to its workers. Defaults to the caller's `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Absolute native artifact cache directory. Its coordinating home must be shared by all writers. */
  buildCache?: string;
  /**
   * Receives output chunks without writing to the importing process's terminal.
   * An exception cancels the operation and rejects it with that exception.
   */
  onProgress?: (event: StimProgress) => void;
}

interface NativeRunOptions {
  slot?: string;
  metroCheck?: boolean;
  buildCache?: boolean;
  remoteBuild?: string;
}

export type StimRunOptions = (
  | (NativeRunOptions & {
      platform: 'ios';
      configuration?: string;
      scheme?: string;
      deviceType?: string;
      runtime?: string;
    })
  | (NativeRunOptions & {
      platform: 'android';
      variant?: string;
      systemImage?: string;
      deviceProfile?: string;
    })
  | { platform: 'macos'; remoteBuild?: string }
  | { platform: 'web'; headed?: boolean }
) & { signal?: AbortSignal };

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
        launched: boolean;
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
}

export type StimStopResult = StopResult;

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

export interface StimReadOptions {
  signal?: AbortSignal;
}

export type StimSettings = SettingsPayload;

export type StimStats = StatsReport;

export interface StimClient {
  readonly projectRoot: string;
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
  /** Reads the existing local timeline; available even when run failed before creating any logs. */
  diagnostics(options?: StimDiagnosticsOptions): Promise<StimDiagnostics>;
  /**
   * Every setting with its effective value, origin and per-layer values for this project, as `stim settings --json`
   * prints them. Runs in the calling process without blocking its event loop on child processes.
   */
  settings(options?: StimReadOptions): Promise<StimSettings>;
  /**
   * Run and build-cache counts for this project and machine, build placement and the last recorded agent-device and
   * SwiftPM cache usage, as `stim stats --json` prints them except that the usage figures are not measured again.
   * Runs in the calling process without blocking its event loop on child processes.
   */
  stats(options?: StimReadOptions): Promise<StimStats>;
}

export interface StimFailure {
  code: string;
  message: string;
  remedy: string | null;
  details?: unknown;
}

type WithoutSignal<T> = T extends unknown ? Omit<T, 'signal'> : never;

export type WorkerRequest =
  | { operation: 'run'; options: WithoutSignal<StimRunOptions> }
  | { operation: 'build'; options: WithoutSignal<StimBuildOptions> }
  | { operation: 'stop'; options: Omit<StimStopOptions, 'signal'> }
  | { operation: 'diagnostics'; options: Omit<StimDiagnosticsOptions, 'signal'> };

export type WorkerResponse =
  | { ok: true; result: StimRunResult | StimBuildResult | StimStopResult | StimDiagnostics }
  | { ok: false; error: StimFailure };
