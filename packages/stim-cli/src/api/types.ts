import type { MacosBuild, NdjsonRecord } from '@stim-cli/core/state';
import type { runStop } from '../commands/stop.ts';
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
  /** Absolute Stim state directory. Omit to use the caller's STIM_HOME or the default home. */
  home?: string;
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

export interface StimStopOptions {
  slot?: string;
  signal?: AbortSignal;
}

export type StimStopResult = Pick<Awaited<ReturnType<typeof runStop>>, 'ok' | 'outcomes' | 'summary'>;

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

export interface StimClient {
  readonly projectRoot: string;
  run(options: StimRunOptions): Promise<StimRunResult>;
  /** Stops this workspace, including resources created before a failed run. Use a fresh signal for cleanup. */
  stop(options?: StimStopOptions): Promise<StimStopResult>;
  /** Reads the existing local timeline; available even when run failed before creating any logs. */
  diagnostics(options?: StimDiagnosticsOptions): Promise<StimDiagnostics>;
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
  | { operation: 'stop'; options: Omit<StimStopOptions, 'signal'> }
  | { operation: 'diagnostics'; options: Omit<StimDiagnosticsOptions, 'signal'> };

export type WorkerResponse =
  | { ok: true; result: StimRunResult | StimStopResult | StimDiagnostics }
  | { ok: false; error: StimFailure };
