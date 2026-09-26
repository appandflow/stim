import chalk from 'chalk';
import type { FingerprintSource } from '@expo/fingerprint';
import { resolveTieredBuild, type CacheProviderConfig, type loadCacheProvider } from '@stim-cli/cache';
import type { BuildCacheHit, BuildPlanPayload, StatsPlatform } from '@stim-cli/core/state';
import { artifactIn, entryDir } from '../cache/build-cache.ts';
import { predictBuildMiss } from '../cache/miss-reason.ts';
import { formatDuration, phaseLine, plural, shortHash } from '../command-output.ts';
import { estimateBuild } from '../engine/build-progress.ts';
import { staleNativeDirRefusal, type planPrebuild } from '../engine/prebuild.ts';
import {
  easAuthNote,
  type checkEasAuth,
  type loadProjectProvider,
  type resolveRemote,
} from '../engine/remote-cache.ts';
import { readStats } from '../engine/stats.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { makeTemporaryDirectory, removeTemporaryEntry } from '../temporary.ts';

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
  loadCacheProvider: typeof loadCacheProvider;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  planPrebuild: typeof planPrebuild;
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
  try {
    const found = await resolveTieredBuild({
      local: { resolve: () => null, store: () => null },
      loadProvider: () => deps.loadCacheProvider({ projectRoot: root, config: providerConfig }),
      target: { projectRoot: root, platform, key: cacheKey },
      destinationDir,
      warn: (_code, message) => deps.note(chalk.yellow(phaseLine('cache', message))),
    });
    return found ? (found.providerName ?? 'the cache provider') : null;
  } finally {
    removeTemporaryEntry(destinationDir);
  }
}

async function expoRemoteHit(lookup: CachedBuildLookup, deps: CachedBuildLookupDeps): Promise<string | null> {
  if (!lookup.expoRemote) return null;
  const { root, platform, isExpo, fingerprint } = lookup;
  const loaded = await deps.loadProjectProvider(root, { isExpo });
  if (loaded?.unavailable) {
    deps.note(chalk.yellow(phaseLine('cache', `provider not usable: ${loaded.unavailable}`)));
    return null;
  }
  if (!loaded?.provider) return null;
  const name = loaded.name ?? 'the build cache provider';
  if (name === 'eas') {
    const auth = deps.checkEasAuth({ projectRoot: root, owner: loaded.owner || null });
    const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
    if (authNote) deps.note(chalk.yellow(phaseLine('cache', authNote)));
    if (auth?.code === 'logged-out') return null;
  }
  const hit = await deps.resolveRemote({
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
  let prebuild: BuildPlanPayload['prebuild'] = null;
  let refusal: Refusal | null = null;
  let missReason: BuildPlanPayload['missReason'];
  if (!cacheHit) {
    prebuild = deps.planPrebuild(root, platform, { isExpo, fingerprint, sources });
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
    ? estimateBuild(readStats().record?.history?.[projectKey], platform, outcome, 'prepare')
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
