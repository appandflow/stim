import type { StimContext } from '@stim-cli/core';
import chalk from 'chalk';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  resolveTieredBuild,
  buildResolveTimeoutMs,
  timeoutFromEnv,
  PROVIDER_LOAD_TIMEOUT_ENV,
  PROVIDER_LOAD_TIMEOUT_MS,
  type CacheProviderConfig,
  type loadCacheProvider,
} from '@stim-cli/cache';
import { reportSignal, trackReportResource } from '../report-runtime.ts';
import type { BuildCacheHit, BuildPlanPayload, StatsPlatform } from '@stim-cli/core/state';
import { artifactIn, entryDir } from '../cache/build-cache.ts';
import { predictBuildMiss } from '../cache/miss-reason.ts';
import { formatDuration, phaseLine, plural, shortHash } from '../command-output.ts';
import { estimateBuild } from '../engine/build-progress.ts';
import { staleNativeDirRefusal, type planPrebuildAsync, type PrebuildAction } from '../engine/prebuild.ts';
import {
  easAuthNote,
  type checkEasAuth,
  type loadProjectProvider,
  type resolveRemote,
} from '../engine/remote-cache.ts';
import { readStats } from '../engine/stats.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { makeTemporaryDirectory, removeTemporaryEntryAsync } from '../temporary.ts';

const DISCARD: NdjsonWriter = {
  file: '',
  written: 0,
  dropped: 0,
  lastError: null,
  write: () => true,
  close: () => ({ file: '', written: 0, dropped: 0, lastError: null }),
};

interface Refusal {
  code: string;
  message: string;
  remedy: string;
}

export interface PlanTarget {
  platform: StatsPlatform;
  slot: string;
  root: string;
  projectKey: string;
}

export interface CachedBuildLookup extends PlanTarget {
  isExpo: boolean;
  fingerprint: string;
  sources: FingerprintSource[];
  cacheKey: string;
  cachePolicy: { read: boolean; remote: boolean };
  providerConfig: CacheProviderConfig | null;
  expoRemote: { runOptions: Record<string, unknown> | null } | null;
}

export interface CachedBuildLookupDeps {
  operation?: StimContext;
  loadCacheProvider: typeof loadCacheProvider;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  planPrebuild: (...args: Parameters<typeof planPrebuildAsync>) => PrebuildAction | Promise<PrebuildAction>;
  note: (line: string) => void;
}

async function providerHit(
  { root, platform, cacheKey, providerConfig }: CachedBuildLookup,
  deps: CachedBuildLookupDeps,
): Promise<string | null> {
  if (!providerConfig) return null;
  let destinationDir: string;
  try {
    destinationDir = makeTemporaryDirectory(root, 'stim-plan-');
  } catch (error) {
    deps.note(chalk.yellow(phaseLine('cache', `provider not checked: ${(error as Error)?.message || error}`)));
    return null;
  }
  let pending: Promise<void> = Promise.resolve();
  const cleanupFailure = Object.assign(
    new Error(`Cache provider cleanup did not finish within 35 seconds. Retained ${destinationDir}.`),
    {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy:
        'Confirm that no cache work is still using the retained download directory before inspecting its permissions and removing it.',
    },
  );
  let cleanup: Promise<void> | undefined;
  let close: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const finish = () =>
    (cleanup ??= finishProviderDownload(pending, destinationDir, cleanupFailure).finally(() => close()));
  trackReportResource(deps.operation, closed, finish, deps.operation?.signal, cleanupFailure);
  try {
    const found = await resolveTieredBuild({
      local: { resolve: () => null, store: () => null },
      loadProvider: async () => {
        const loaded = await deps.loadCacheProvider({
          projectRoot: root,
          config: providerConfig,
          ...(deps.operation ? { env: deps.operation.env } : {}),
          timeoutMs: timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, PROVIDER_LOAD_TIMEOUT_MS, deps.operation?.env),
        });
        const capability = loaded?.provider?.builds;
        if (!capability) return loaded;
        return {
          ...loaded,
          provider: {
            ...loaded.provider,
            builds: {
              store: capability.store.bind(capability),
              resolve: (request) => {
                const resolving = Promise.resolve().then(() => capability.resolve(request));
                pending = resolving.then(
                  () => undefined,
                  (cause: unknown) => {
                    if (cause instanceof Error && 'reportCleanup' in cause) throw cause;
                  },
                );
                return resolving;
              },
            },
          },
        };
      },
      signal: deps.operation?.signal,
      timeoutMs: buildResolveTimeoutMs(deps.operation?.env),
      target: { projectRoot: root, platform, key: cacheKey },
      destinationDir,
      warn: (_code, message) => deps.note(chalk.yellow(phaseLine('cache', message))),
    });
    return found ? (found.providerName ?? 'the cache provider') : null;
  } finally {
    await finish();
  }
}

async function finishProviderDownload(
  pending: Promise<void>,
  destinationDir: string,
  cleanupFailure: Error,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    pending.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 35_000);
    }),
  ]).finally(() => clearTimeout(timer));
  // @stim-cli/cache requires providers to settle on abort; a violating provider may still write to its scratch directory.
  if (!drained) throw cleanupFailure;
  try {
    await removeTemporaryEntryAsync(destinationDir);
  } catch (cause) {
    throw Object.assign(new Error(`Cache provider download cleanup failed. Retained ${destinationDir}.`, { cause }), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy: 'Check the retained directory permissions and remove it before retrying.',
    });
  }
}

async function expoRemoteHit(lookup: CachedBuildLookup, deps: CachedBuildLookupDeps): Promise<string | null> {
  if (!lookup.expoRemote) return null;
  const { root, platform, isExpo, fingerprint } = lookup;
  const loaded = await deps.loadProjectProvider(root, {
    isExpo,
    context: deps.operation,
    allowPlugins: !reportSignal(deps.operation),
  });
  if (loaded?.unavailable) {
    deps.note(chalk.yellow(phaseLine('cache', `provider not usable: ${loaded.unavailable}`)));
    return null;
  }
  if (!loaded?.provider) return null;
  const name = loaded.name ?? 'the build cache provider';
  if (name === 'eas') {
    const auth = await deps.checkEasAuth({ context: deps.operation, projectRoot: root, owner: loaded.owner || null });
    const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
    if (authNote) deps.note(chalk.yellow(phaseLine('cache', authNote)));
    if (auth?.code === 'logged-out') return null;
  }
  const hit = await deps.resolveRemote({
    context: deps.operation,
    provider: loaded.provider,
    platform,
    projectRoot: root,
    fingerprintHash: fingerprint,
    runOptions: lookup.expoRemote.runOptions,
    logWriter: DISCARD,
  });
  if (hit?.timedOut) deps.note(chalk.yellow(phaseLine('cache', `${name} did not answer; counted as a miss`)));
  else if (hit?.failed) deps.note(chalk.yellow(phaseLine('cache', `${name} could not be used: ${hit.failed}`)));
  return hit?.appPath ? name : null;
}

export async function planCachedBuild(
  lookup: CachedBuildLookup,
  deps: CachedBuildLookupDeps,
): Promise<BuildPlanPayload> {
  const { root, platform, isExpo, fingerprint, sources, cacheKey, cachePolicy } = lookup;
  deps.operation?.signal.throwIfAborted();
  let cacheHit: BuildCacheHit = false;
  let provider: string | null = null;
  if (cachePolicy.read) {
    if (artifactIn(entryDir(platform, cacheKey))) {
      cacheHit = 'local';
    } else {
      provider = (cachePolicy.remote ? await providerHit(lookup, deps) : null) ?? (await expoRemoteHit(lookup, deps));
      if (provider) cacheHit = 'remote';
    }
  }
  deps.operation?.signal.throwIfAborted();
  let prebuild: BuildPlanPayload['prebuild'] = null;
  let refusal: Refusal | null = null;
  let missReason: BuildPlanPayload['missReason'];
  if (!cacheHit) {
    prebuild = await deps.planPrebuild(root, platform, { isExpo, fingerprint, sources }, deps.operation?.signal);
    if (prebuild === 'refuse') refusal = staleNativeDirRefusal(platform);
    else if (cachePolicy.read) {
      missReason = predictBuildMiss({
        root,
        platform,
        current: { hash: fingerprint, sources },
        prebuild: prebuild === 'generate' || prebuild === 'regenerate' ? prebuild : null,
      });
    }
  }
  return planPayload(lookup, {
    fingerprint,
    cacheKey,
    cacheHit,
    provider,
    cacheSkipped: !cachePolicy.read,
    prebuild,
    ...(missReason ? { missReason } : {}),
    refusal,
  });
}

export function planPayload(
  { platform, slot, projectKey }: PlanTarget,
  found: Pick<
    BuildPlanPayload,
    'fingerprint' | 'cacheKey' | 'cacheHit' | 'provider' | 'cacheSkipped' | 'prebuild' | 'missReason'
  > & {
    refusal: Refusal | null;
  },
): BuildPlanPayload {
  const { refusal, missReason, ...rest } = found;
  const outcome = refusal ? null : found.cacheHit ? 'hit' : 'cold';
  const estimate = outcome
    ? estimateBuild(readStats().record?.history?.[projectKey], platform, outcome)
    : { expectedMs: null, basis: 0 };
  return {
    platform,
    ...(slot === 'default' ? {} : { slot }),
    ...rest,
    outcome,
    expectedMs: estimate.expectedMs,
    basis: estimate.basis,
    ...(missReason ? { missReason } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

function cacheLine(plan: BuildPlanPayload): string {
  if (plan.refusal) return `the build would refuse with ${plan.refusal.code}`;
  if (plan.cacheHit === 'local') return 'local cache hit';
  if (plan.cacheHit === 'remote') return `remote cache hit (${plan.provider})`;
  const why = plan.cacheSkipped ? 'cache reads are off' : 'cache miss';
  const prebuild =
    plan.prebuild === 'generate' || plan.prebuild === 'regenerate' ? `, ${plan.prebuild}s the native dir` : '';
  return `${why}: compiles${prebuild}`;
}

export function printPlan(plan: BuildPlanPayload, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(plan));
    return;
  }
  const slot = plan.slot ? ` [${plan.slot}]` : '';
  console.log(phaseLine('plan', `${plan.platform}${slot} ${shortHash(plan.fingerprint)} -> ${cacheLine(plan)}`));
  if (plan.placement) console.log(phaseLine('placement', plan.placement));
  if (plan.missReason) console.log(phaseLine('cache', `miss: ${plan.missReason.summary}`));
  if (plan.refusal) {
    console.log(phaseLine('error', plan.refusal.message));
    console.log(phaseLine('remedy', plan.refusal.remedy));
    return;
  }
  console.log(
    phaseLine(
      'expect',
      plan.expectedMs === null
        ? `unknown: no ${plan.outcome} run of this project is recorded yet`
        : `~${formatDuration(plan.expectedMs)} (median of ${plural(plan.basis, `${plan.outcome} run`)})`,
    ),
  );
}

export function refusePlan({ code, message, remedy }: Refusal, json: boolean, lines: string[] = []): void {
  console.error(chalk.red(phaseLine('error', message)));
  for (const line of lines) console.error(chalk.dim(phaseLine('', line)));
  console.error(chalk.dim(phaseLine('remedy', remedy)));
  console.error(chalk.red(phaseLine('failed', code)));
  if (json) console.log(JSON.stringify({ code, message, remedy }));
  process.exitCode = 1;
}

const PLAN_ONLY_REMEDY =
  'Drop the flag to plan the owned simulator or emulator build, or run the command without --plan.';

export function planFlagRefusal(flag: string): Refusal {
  return {
    code: 'STIM_BAD_ARG',
    message: `${flag} does not apply to --plan, which predicts the next local build without choosing a device.`,
    remedy: PLAN_ONLY_REMEDY,
  };
}
