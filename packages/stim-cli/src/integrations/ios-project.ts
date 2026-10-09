import type { BuildCacheCapability } from '@stim-cli/cache';
import type { BuildMissReason } from '@stim-cli/core/state';
import type { IosRuntimePlan } from '../commands/ios/launch.ts';
import type { FailArgs, IosCommandOptions } from '../commands/ios/types.ts';
import type { ProjectBuildPlanner } from './project-plan.ts';
import type { BuildIosResult } from '../engine/xcode.ts';
import type { SimulatorArch } from '../engine/agent-device.ts';
import type { BuildPhase } from '../engine/build-progress.ts';
import type { RunEstimates } from '../engine/stats.ts';
import type { LoadProjectProviderResult } from '../engine/remote-cache.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { artifactCachePolicy, Optimizations } from '../optimizations.ts';
import type { chooseBuildMachine, offloadBuild } from '../offload/client.ts';

interface IosArtifactIdentity {
  hash: string;
  key: string;
}

export interface IosSourcePreparation {
  identity: IosArtifactIdentity | null;
  rekeyedBy: string[];
  mutationLabel: string;
}

export interface IosArtifactRecipe {
  identity(): Promise<IosArtifactIdentity | { cacheIneligible: string }>;
  cache(): BuildCacheCapability;
  prepare(beforePrepare: () => void): Promise<void>;
  reconcile(): Promise<IosSourcePreparation>;
  validate(): Promise<IosArtifactIdentity | null>;
  validateExternal(path: string): void;
  materialize(path: string, options: { fresh: boolean; ownTemporary(directory: string): void }): Promise<string | null>;
  compile(): Promise<BuildIosResult>;
  explain(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null };
  untrackedLine(): string | null;
  legacyCache: {
    load(): Promise<LoadProjectProviderResult>;
    runOptions: { configuration?: string; arch?: string } | null;
  } | null;
  offload: {
    context(): { runtime: string | null; unsupported: string | null };
    target(runtime: string): Parameters<typeof chooseBuildMachine>[0]['target'];
    request(runtime: string): Extract<Parameters<typeof offloadBuild>[0]['request'], { platform: 'ios' }>;
    unchanged(): Promise<boolean>;
  } | null;
}

export interface IosArtifactContext {
  root: string;
  logFile: string;
  configuration: string | null;
  buildScheme?: string;
  buildProfile?: string;
  target: {
    udid: string;
    destination: string | null;
    sdk: string;
    arch: SimulatorArch | null;
    keyArch: SimulatorArch | null;
    offloadRuntime(): string | null;
    hostedArchitecture?: SimulatorArch;
    offloadRefusal: string | null;
  };
  device: {
    lanAddress: string | null;
    metroPort: number | null;
    signingName: string | null;
    signingSha1: string | null;
  } | null;
  easProfile?: string;
  optimizations: Optimizations['ios'];
  cache: ReturnType<typeof artifactCachePolicy>;
  phase(name: unknown, text: string): void;
  note(line: string): void;
  logWriter(): NdjsonWriter;
  estimates(): RunEstimates;
  step(phase: BuildPhase): void;
  setPodsMs(ms: number): void;
}

export interface IosProject {
  plan?: ProjectBuildPlanner<IosCommandOptions>;
  isExpo: boolean;
  bundleId(): string | null;
  schemeProblem(scheme: string | undefined): FailArgs | null;
  targets: readonly ('simulator' | 'physical' | 'remote' | 'hosted')[];
  eas: boolean;
  runtime(args: {
    configuration: string | null;
    prepareMetro: IosRuntimePlan['prepare'];
    prepareEmbedded: IosRuntimePlan['prepare'];
  }): IosRuntimePlan;
  artifact(context: IosArtifactContext): IosArtifactRecipe;
}

export class IosRecipeRefusal extends Error {
  readonly failure: FailArgs;

  constructor(failure: FailArgs) {
    super(failure.message ?? failure.code);
    this.failure = failure;
  }
}
