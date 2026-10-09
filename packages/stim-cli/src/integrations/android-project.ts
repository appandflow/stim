import type { BuildCacheCapability } from '@stim-cli/cache';
import type { BuildMissReason } from '@stim-cli/core/state';
import type { AndroidBuildPlan, AndroidRunPlan } from '../commands/android/plan.ts';
import type { AndroidPlanOptions } from '../commands/android/next-build.ts';
import type { ProjectBuildPlanner } from './project-plan.ts';
import type { AndroidRuntimeKind, AndroidRuntimePlan } from '../commands/android/launch.ts';
import type { AndroidWriter, FailExtra } from '../commands/android/types.ts';
import type { BuildAndroidResult } from '../engine/gradle.ts';
import type { LoadProjectProviderResult } from '../engine/remote-cache.ts';
import type { BuildPhase } from '../engine/build-progress.ts';
import type { RunEstimates } from '../engine/stats.ts';
import type { chooseBuildMachine, offloadBuild } from '../offload/client.ts';
import type { SettingsObject } from '../workspace/settings.ts';

interface AndroidBuildTarget {
  abi: string | null;
}

interface AndroidArtifactIdentity {
  hash: string;
  key: string;
}

export interface AndroidSourcePreparation {
  identity: AndroidArtifactIdentity | null;
  rekeyedBy: string[];
  cacheRefusal: string | null;
  androidPackage?: string | null;
}

export interface AndroidArtifactRecipe {
  identity(): Promise<AndroidArtifactIdentity | { cacheIneligible: string }>;
  cache(compiled?: boolean): BuildCacheCapability;
  prepare(beforePrepare: () => void): Promise<void>;
  reconcile(): Promise<AndroidSourcePreparation>;
  validate(): Promise<AndroidArtifactIdentity | null>;
  materialize(key: string, path: string): Promise<{ apkPath: string; directory: string | null } | null>;
  compile(): Promise<BuildAndroidResult>;
  explain(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null };
  untrackedLine(): string | null;
  legacyCache: {
    load(): Promise<LoadProjectProviderResult>;
    runOptions: { variant?: string; abi?: string; compiler?: string; buildProfile?: string } | null;
  } | null;
  offload: {
    supportsUncachedArtifacts?: boolean;
    unsupported: string | null;
    target(): Parameters<typeof chooseBuildMachine>[0]['target'];
    request: Extract<Parameters<typeof offloadBuild>[0]['request'], { platform: 'android' }>;
    unchanged(): Promise<boolean>;
  } | null;
}

export interface AndroidArtifactContext {
  root: string;
  buildLog: string;
  writer: AndroidWriter;
  settings: SettingsObject;
  buildPlan: AndroidBuildPlan['build'];
  target: AndroidBuildTarget;
  phase: (label: unknown, text: string) => void;
  out: (line: string) => void;
  step: (phase: BuildPhase) => void;
  estimates: () => RunEstimates;
}

export interface AndroidProject {
  plan?: ProjectBuildPlanner<AndroidPlanOptions>;
  isExpo: boolean;
  packageRemedy: string;
  appIds(): { bundleId: string | null; androidPackage: string | null };
  variantProblem(variant: string | null): { code: string; reason: string; remedy: string } | null;
  targets: readonly AndroidRunPlan['target']['kind'][];
  eas: boolean;
  runtimeKind(build: Pick<AndroidBuildPlan['build'], 'release'>): AndroidRuntimeKind;
  runtime(args: {
    build: AndroidBuildPlan['build'];
    prepareMetro: AndroidRuntimePlan['prepare'];
    phase: AndroidArtifactContext['phase'];
  }): AndroidRuntimePlan;
  artifact(context: AndroidArtifactContext): AndroidArtifactRecipe;
}

export interface AndroidArtifactFailure {
  code: string | undefined;
  message: string | null | undefined;
  remedy: string | null | undefined;
  extra: FailExtra;
}

export class AndroidRecipeRefusal extends Error {
  readonly failure: AndroidArtifactFailure;
  readonly missReason?: BuildMissReason;

  constructor(failure: AndroidArtifactFailure, missReason?: BuildMissReason) {
    super(failure.message ?? failure.code);
    this.failure = failure;
    this.missReason = missReason;
  }
}
