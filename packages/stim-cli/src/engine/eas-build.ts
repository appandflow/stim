import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { getExecutor } from '../exec.ts';
import { claimFailure } from '../ownership-claim.ts';
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
  | { ok: true; path: string; fingerprint: string; cacheKey: string; cacheHit: 'remote' };

export function isEasBuildFailure(result: EasBuildResult | null): result is { ok: false } & Refusal {
  return result?.ok === false;
}

export function easOptionRefusal({
  profile,
  isExpo,
  buildSelector,
  buildCache,
}: {
  profile?: string;
  isExpo: boolean;
  buildSelector?: string;
  buildCache?: boolean;
}): Refusal | null {
  if (profile === undefined) return null;
  if (profile.trim() && isExpo && buildSelector === undefined && buildCache !== false) return null;
  return {
    code: 'STIM_BAD_ARG',
    message: '--eas-profile requires an Expo project and a non-empty development profile.',
    remedy: 'Use --eas-profile <name> without --scheme, --configuration, --variant, or --no-build-cache.',
  };
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function shellArg(value: string): string {
  return /^[a-zA-Z0-9_.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function easDeviceBuildRemedy(profile: string): string {
  return `If the device is not registered, run npx eas-cli device:create. With approval for cloud build costs and signing changes, run npx eas-cli build --platform ios --profile ${shellArg(profile)} to produce a build with a valid profile for this device, then retry the same Stim command.`;
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
    physical = false,
  }: { platform: Platform; profile: string; fingerprint: string; projectId: string; physical?: boolean },
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
      (platform !== 'ios' || build.isForIosSimulator === !physical) &&
      build.distribution === 'INTERNAL' &&
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
  note: (line: string) => void;
}): Promise<EasBuildResult | null> {
  if (profile === undefined) return null;
  const refusal = easOptionRefusal({
    profile,
    isExpo,
    buildSelector: selectors.find((value) => value != null) ?? undefined,
    buildCache,
  });
  if (refusal) return { ok: false, ...refusal };
  const retry = 'the same Stim command';
  const buildCommand = `npx eas-cli build --platform ${platform} --profile ${shellArg(profile)}`;
  let lock: ReturnType<typeof acquireBuildLock> | null = null;
  try {
    const cli = resolveEasCliBin(root);
    if (!cli)
      throw new EasFailure(
        'STIM_EAS_UNAVAILABLE',
        'EAS CLI is not installed.',
        'Install eas-cli, run eas login, then retry.',
      );
    let profileEnv: Record<string, string> = {};
    const run = (args: string[], timeoutMs = 120_000): unknown => {
      try {
        return JSON.parse(
          getExecutor().runFile(cli.file, [...args, '--json', '--non-interactive'], {
            cwd: root,
            timeoutMs,
            env: profileEnv,
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
    // EAS build:list treats --build-profile only as a filter; project context uses the process environment.
    profileEnv = object(buildProfile.env) as Record<string, string>;
    const appConfig = object(config.appConfig);
    const projectId = object(object(appConfig.extra).eas).projectId;
    if (
      buildProfile.developmentClient !== true ||
      buildProfile.distribution !== 'internal' ||
      (platform === 'ios' && (buildProfile.simulator === true) !== !physical)
    ) {
      throw new EasFailure(
        'STIM_BAD_ARG',
        `EAS profile ${profile} is not an internal development build for this ${platform} target.`,
        `Set developmentClient: true and distribution: internal${platform === 'ios' ? `, with ios.simulator: ${!physical}` : ''} in that eas.json profile.`,
      );
    }
    if (typeof projectId !== 'string' || !projectId) {
      throw new EasFailure(
        'STIM_BAD_ARG',
        'The Expo app is not linked to an EAS project.',
        'Link the intended EAS project with eas init, then retry.',
      );
    }
    if (
      platform === 'ios'
        ? buildProfile.buildConfiguration !== undefined && buildProfile.buildConfiguration !== 'Debug'
        : buildProfile.gradleCommand !== undefined &&
          (typeof buildProfile.gradleCommand !== 'string' ||
            !/^:app:assemble\w*Debug$/.test(buildProfile.gradleCommand))
    ) {
      throw new EasFailure(
        'STIM_BAD_ARG',
        `EAS profile ${profile} overrides the development build configuration.`,
        'Use ios.buildConfiguration: Debug or an android.gradleCommand that assembles a single Debug APK, or remove the override.',
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
      ...(platform === 'ios' && !physical ? ['--simulator'] : ['--distribution', 'internal']),
      '--limit',
      '1',
    ]);
    const buildId = selectEasBuild(builds, { platform, profile, fingerprint, projectId, physical });
    if (!buildId) {
      throw new EasFailure(
        'STIM_EAS_BUILD_MISSING',
        `No compatible EAS ${platform} build exists for profile ${profile} and fingerprint ${fingerprint}.`,
        `A cloud build may incur charges. With approval to run it, use ${buildCommand}, then retry ${retry}.`,
      );
    }
    const identity = createHash('sha256').update(JSON.stringify({ projectId, buildId })).digest('hex');
    const cacheKey = `eas-${identity}-debug-${physical && platform === 'ios' ? 'device' : 'sim'}`;
    lock = acquireBuildLock({ platform, key: cacheKey, root });
    if (!lock.acquired) {
      throw new EasFailure(
        'STIM_EAS_UNAVAILABLE',
        `Another run holds the EAS artifact claim at ${lock.path}.`,
        `Wait for that run to finish, then retry ${retry}.`,
      );
    }
    note(`eas   resolving artifact for build ${buildId}`);
    const result = object(run(['build:download', '--build-id', buildId], 10 * 60_000));
    if (typeof result.path !== 'string' || !existsSync(result.path))
      throw new Error('EAS returned no downloaded artifact.');
    const path = realpathSync(result.path);
    if (
      platform === 'ios'
        ? !path.endsWith('.app') || !statSync(path).isDirectory()
        : !path.endsWith('.apk') || !statSync(path).isFile()
    ) {
      throw new Error('EAS returned an unexpected artifact path or type.');
    }
    note(`eas   artifact ready ${fingerprint.slice(0, 8)}`);
    return { ok: true, path, fingerprint, cacheKey, cacheHit: 'remote' };
  } catch (error) {
    const claim = claimFailure(error, null);
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
    releaseBuildLock(lock);
  }
}
