import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveBuild, storeBuild } from '../build-cache.ts';
import { register } from '../cache-manifest.ts';
import { getExecutor } from '../exec.ts';
import { claimFailure } from '../ownership-claim.ts';
import { workspaceDir } from '../paths.ts';
import { acquireBuildLock, releaseBuildLock } from './build-lock.ts';
import { resolveEasCliBin } from './remote-cache.ts';

type Platform = 'ios' | 'android';
type JsonObject = Record<string, unknown>;

interface Refusal {
  code: string;
  message: string;
  remedy: string;
}

export type EasBuildResult =
  | ({ ok: false } & Refusal)
  | { ok: true; path: string; fingerprint: string; cacheKey: string; cacheHit: 'local' | 'remote' };

export function isEasBuildFailure(result: EasBuildResult | null): result is { ok: false } & Refusal {
  return result?.ok === false;
}

export function easOptionRefusal({
  profile,
  isExpo,
  physical,
  buildSelector,
  buildCache,
}: {
  profile?: string;
  isExpo: boolean;
  physical: boolean;
  buildSelector?: string;
  buildCache?: boolean;
}): Refusal | null {
  if (profile === undefined) return null;
  if (profile.trim() && isExpo && !physical && buildSelector === undefined && buildCache !== false) return null;
  return {
    code: 'STIM_BAD_ARG',
    message:
      '--eas-profile requires an Expo project, a non-empty development profile, and a simulator or emulator target.',
    remedy: 'Use --eas-profile <name> without --device, --scheme, --configuration, --variant, or --no-build-cache.',
  };
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function shellArg(value: string): string {
  return /^[a-zA-Z0-9_.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

class EasFailure extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.code = code;
    this.remedy = remedy;
  }
}

export function selectEasBuild(
  builds: unknown,
  {
    platform,
    profile,
    fingerprint,
    projectId,
  }: { platform: Platform; profile: string; fingerprint: string; projectId: string },
): string | null {
  if (!Array.isArray(builds)) throw new Error('EAS build:list did not return an array.');
  for (const value of builds) {
    const build = object(value);
    if (
      typeof build.id === 'string' &&
      build.id.length > 0 &&
      build.status === 'FINISHED' &&
      build.platform === platform.toUpperCase() &&
      build.buildProfile === profile &&
      object(build.fingerprint).hash === fingerprint &&
      object(build.project).id === projectId &&
      (platform === 'ios' ? build.isForIosSimulator === true : build.distribution === 'INTERNAL') &&
      typeof object(build.artifacts).applicationArchiveUrl === 'string'
    )
      return build.id;
  }
  return null;
}

export async function resolveEasDevelopmentBuild({
  root,
  platform,
  profile,
  cache,
  note,
  isExpo = true,
  physical = false,
  selectors = [],
  buildCache,
}: {
  root: string;
  platform: Platform;
  profile?: string;
  isExpo?: boolean;
  physical?: boolean;
  selectors?: (string | null | undefined)[];
  buildCache?: boolean;
  cache: { read: boolean; write: boolean };
  note: (line: string) => void;
}): Promise<EasBuildResult | null> {
  if (profile === undefined) return null;
  const refusal = easOptionRefusal({
    profile,
    isExpo,
    physical,
    buildSelector: selectors.find((value) => value != null) ?? undefined,
    buildCache,
  });
  if (refusal) return { ok: false, ...refusal };
  const retry = `stim ${platform} --eas-profile ${shellArg(profile)}`;
  const buildCommand = `npx eas-cli build --platform ${platform} --profile ${shellArg(profile)}`;
  const scratchRoot = join(workspaceDir(root), 'eas-downloads');
  let scratch: string | null = null;
  let keepScratch = false;
  let lock: ReturnType<typeof acquireBuildLock> | null = null;
  try {
    const cli = resolveEasCliBin(root);
    if (!cli)
      throw new EasFailure(
        'STIM_EAS_UNAVAILABLE',
        'EAS CLI is not installed.',
        'Install eas-cli, run eas login, then retry.',
      );
    const run = (args: string[], timeoutMs = 120_000, env?: Record<string, string>): unknown => {
      try {
        return JSON.parse(
          getExecutor().runFile(cli.file, [...args, '--json', '--non-interactive'], {
            cwd: root,
            timeoutMs,
            env,
          }),
        );
      } catch {
        throw new EasFailure(
          'STIM_EAS_UNAVAILABLE',
          `EAS ${args[0]} failed or returned invalid JSON.`,
          `Run npx eas-cli ${args.map(shellArg).join(' ')} to inspect the error, then retry ${retry}.`,
        );
      }
    };
    note(`eas   resolving profile ${profile}`);
    const config = object(run(['config', '--platform', platform, '--profile', profile]));
    const buildProfile = object(config.buildProfile);
    const appConfig = object(config.appConfig);
    const projectId = object(object(appConfig.extra).eas).projectId;
    if (
      buildProfile.developmentClient !== true ||
      buildProfile.distribution !== 'internal' ||
      (platform === 'ios' && buildProfile.simulator !== true)
    ) {
      throw new EasFailure(
        'STIM_BAD_ARG',
        `EAS profile ${profile} is not an internal development build for ${platform}.`,
        `Set developmentClient: true and distribution: internal${platform === 'ios' ? ', with ios.simulator: true' : ''} in that eas.json profile.`,
      );
    }
    if (typeof projectId !== 'string' || !projectId) {
      throw new EasFailure(
        'STIM_BAD_ARG',
        'The Expo app is not linked to an EAS project.',
        'Link the intended EAS project with eas init, then retry.',
      );
    }
    note(`eas   fingerprinting ${platform} with profile ${profile}`);
    const fingerprint = object(run(['fingerprint:generate', '--platform', platform, '--build-profile', profile])).hash;
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{40,64}$/.test(fingerprint)) {
      throw new EasFailure(
        'STIM_EAS_UNAVAILABLE',
        'EAS returned no valid native fingerprint.',
        `Run npx eas-cli fingerprint:generate --platform ${platform} --build-profile ${shellArg(profile)} to inspect the result.`,
      );
    }
    const identity = createHash('sha256')
      .update(JSON.stringify({ projectId, profile, buildProfile, fingerprint }))
      .digest('hex');
    const cacheKey = `eas-${identity}-debug-sim`;
    const local = cache.read ? resolveBuild(platform, cacheKey) : null;
    if (local) {
      note(`eas   local hit ${fingerprint.slice(0, 8)}`);
      return { ok: true, path: local, fingerprint, cacheKey, cacheHit: 'local' };
    }
    lock = acquireBuildLock({ platform, key: cacheKey, root });
    if (!lock.acquired) {
      throw new EasFailure(
        'STIM_EAS_UNAVAILABLE',
        `Another run holds the EAS artifact claim at ${lock.path}.`,
        `Wait for that run to finish, then retry ${retry}.`,
      );
    }
    const rechecked = cache.read ? resolveBuild(platform, cacheKey) : null;
    if (rechecked) return { ok: true, path: rechecked, fingerprint, cacheKey, cacheHit: 'local' };
    note(`eas   looking for ${fingerprint.slice(0, 8)}`);
    const builds = run([
      'build:list',
      '--platform',
      platform,
      '--build-profile',
      profile,
      '--fingerprint-hash',
      fingerprint,
      '--status',
      'finished',
      ...(platform === 'ios' ? ['--simulator'] : ['--distribution', 'internal']),
      '--limit',
      '1',
    ]);
    const buildId = selectEasBuild(builds, { platform, profile, fingerprint, projectId });
    if (!buildId) {
      throw new EasFailure(
        'STIM_EAS_BUILD_MISSING',
        `No compatible EAS ${platform} build exists for profile ${profile} and fingerprint ${fingerprint}.`,
        `A cloud build may incur charges. With approval to run it, use ${buildCommand}, then retry ${retry}.`,
      );
    }
    mkdirSync(scratchRoot, { recursive: true });
    register({ dir: scratchRoot, name: 'EAS downloads', prune: 'entries', note: 'downloaded development builds' });
    scratch = mkdtempSync(join(scratchRoot, 'download-'));
    note(`eas   downloading build ${buildId}`);
    const result = object(run(['build:download', '--build-id', buildId], 10 * 60_000, { TMPDIR: scratch }));
    if (typeof result.path !== 'string' || !existsSync(result.path))
      throw new Error('EAS returned no downloaded artifact.');
    const path = realpathSync(result.path);
    const within = relative(realpathSync(scratch), path);
    if (
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith(`..${sep}`) ||
      (platform === 'ios'
        ? !path.endsWith('.app') || !statSync(path).isDirectory()
        : !path.endsWith('.apk') || !statSync(path).isFile())
    ) {
      throw new Error('EAS returned an unexpected artifact path or type.');
    }
    const stored = cache.write ? storeBuild(platform, cacheKey, path) : null;
    keepScratch = !stored;
    note(`eas   downloaded ${fingerprint.slice(0, 8)}${stored ? ' -> stored locally' : ''}`);
    return { ok: true, path: stored ?? path, fingerprint, cacheKey, cacheHit: 'remote' };
  } catch (error) {
    const claim = claimFailure(error, retry);
    if (claim) return { ok: false, code: claim.code, message: claim.message, remedy: claim.remedy };
    if (error instanceof EasFailure)
      return { ok: false, code: error.code, message: error.message, remedy: error.remedy };
    return {
      ok: false,
      code: 'STIM_EAS_UNAVAILABLE',
      message: `Could not resolve the EAS development build: ${(error as Error).message}`,
      remedy: `Retry ${retry}. No cloud build was started.`,
    };
  } finally {
    try {
      if (scratch && !keepScratch) rmSync(scratch, { recursive: true, force: true });
    } finally {
      releaseBuildLock(lock);
    }
  }
}
