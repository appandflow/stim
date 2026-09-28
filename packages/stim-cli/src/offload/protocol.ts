import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESULT_MARKER = 'STIM_OFFLOAD_RESULT ';

export interface WorkerProbe {
  stimVersion: string | null;
  stimBuildId: string | null;
  xcode: string | null;
  simulatorSdk: string | null;
  runtimes: string[];
  cocoapods: string | null;
  node: string;
  arch: string;
  cpus: number;
  load1: number;
  availableMemBytes: number | null;
  diskFreeBytes: number | null;
  xcodebuildRunning: number;
}

export interface WorkerBuildRequest {
  repoDir: string;
  projectRel: string;
  packageName: string | null;
  expectedFingerprint: string;
  configuration: string | null;
  scheme: string | null;
  isExpo: boolean;
  optimizations: unknown;
  /** SimRuntime identifier of the local target simulator, e.g. com.apple.CoreSimulator.SimRuntime.iOS-27-0. */
  runtime: string | null;
}

export interface WorkerTimings {
  depsMs: number;
  prebuildMs: number;
  podsMs: number;
  fingerprintMs: number;
  buildMs: number;
}

export type WorkerBuildResult =
  | {
      ok: true;
      appPath: string;
      fingerprint: string;
      depsInstalled: boolean;
      prebuild: string;
      podsInstalled: boolean;
      compilationCache: string;
      timings: WorkerTimings;
    }
  | {
      ok: false;
      code: string;
      message: string;
      fingerprint?: string | null;
      sources?: unknown[];
      timings?: Partial<WorkerTimings>;
    };

export function parseWorkerOutput<T>(stdout: string): T | null {
  const line = stdout
    .split('\n')
    .toReversed()
    .find((l) => l.startsWith(RESULT_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(RESULT_MARKER.length)) as T;
  } catch {
    return null;
  }
}

/** A digest of the built dist chunks, so both sides can prove they run the same Stim code. */
export function distBuildId(distDir: string): string | null {
  try {
    const hash = createHash('sha256');
    for (const name of readdirSync(distDir)
      .filter((n) => n.endsWith('.mjs'))
      .toSorted()) {
      hash.update(name);
      hash.update(readFileSync(join(distDir, name)));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
