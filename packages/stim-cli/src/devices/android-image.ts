import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import type { SettingsObject } from '@stim-cli/core/state';
import { cancellableSleep } from '../cancellation.ts';
import { getExecutor } from '../exec.ts';
import {
  claimFailure,
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { captureProcessIdentity } from '../process-identity.ts';
import { settingValueAt } from '../workspace/settings.ts';
import {
  androidHome,
  androidToolPath,
  hostSystemImageArch,
  listInstalledSystemImages,
  pickDefaultSystemImage,
  type SystemImage,
} from './android.ts';
import { recordInstalledSystemImageAsync } from './created-devices.ts';

const RECOMMENDED_ANDROID_API = 36;
const IMAGE_INSTALL_FREE_BYTES = 8 * 1024 ** 3;
const IMAGE_INSTALL_TIMEOUT_MS = 30 * 60_000;
const CLAIM_POLL_MS = 2000;
const SYSTEM_IMAGE_PACKAGE = /^system-images;android-\d+;[^;\s]+;([^;\s]+)$/;
// sdkmanager 19 answers an unaccepted license prompt with these lines and still exits 0.
const LICENSE_NOT_ACCEPTED =
  /license is not accepted|licenses or those of the packages they depend on were not accepted/i;

export type AndroidImageInstallPolicy = 'auto' | 'never';

export interface SystemImageRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type SystemImageDecision =
  | { kind: 'installed'; pkg: string }
  | { kind: 'install'; pkg: string }
  | ({ kind: 'refuse' } & SystemImageRefusal);

function recommendedSystemImage(arch: string = hostSystemImageArch()): string {
  return `system-images;android-${RECOMMENDED_ANDROID_API};google_apis;${arch}`;
}

export function androidImageInstallPolicy(
  settings: SettingsObject | object | null | undefined,
): AndroidImageInstallPolicy {
  return settingValueAt(settings, 'android.installImages') === 'never' ? 'never' : 'auto';
}

function sdkmanagerCommand(args: string, env?: NodeJS.ProcessEnv): string {
  const tool = androidToolPath('sdkmanager', process.platform, env);
  return `${isAbsolute(tool) ? JSON.stringify(tool) : tool} ${args}`;
}

/**
 * Decides which system image an owned AVD uses: the requested one, else the newest installed image for the host, else
 * Stim's recommended image. An image that is not installed is installed only when the policy allows it and its ABI is
 * the host's.
 */
export function decideSystemImage({
  requested,
  installed,
  policy,
  hostArch = hostSystemImageArch(),
  env,
}: {
  requested: string | null;
  installed: readonly SystemImage[];
  policy: AndroidImageInstallPolicy;
  hostArch?: string;
  env?: NodeJS.ProcessEnv;
}): SystemImageDecision {
  if (requested && installed.some((image) => image.pkg === requested)) return { kind: 'installed', pkg: requested };
  const picked = requested ? null : pickDefaultSystemImage([...installed], { hostArch });
  if (picked) return { kind: 'installed', pkg: picked.pkg };
  const pkg = requested ?? recommendedSystemImage(hostArch);
  const arch = SYSTEM_IMAGE_PACKAGE.exec(pkg)?.[1];
  if (arch !== hostArch)
    return {
      kind: 'refuse',
      code: 'STIM_BAD_ARG',
      message: arch
        ? `The Android system image "${pkg}" is not installed, and Stim installs only ${hostArch} images on this machine.`
        : `"${pkg}" is not an Android system image package id.`,
      remedy: `Pass \`--system-image\` (or set android.systemImage) to an installed image, or to one Stim can install for ${hostArch} such as "${recommendedSystemImage(hostArch)}".`,
    };
  if (policy === 'never')
    return {
      kind: 'refuse',
      code: requested ? 'STIM_BAD_ARG' : 'STIM_NO_DEVICE',
      message: `${requested ? `The Android system image "${pkg}" is not installed` : `No ${hostArch} Android system image is installed`}, and android.installImages is never, so Stim does not install one.`,
      remedy: `${requested ? 'Pass `--system-image` (or set android.systemImage) to an installed image, run' : 'Run'} \`${sdkmanagerCommand(`--install "${pkg}"`, env)}\` on this machine, or set android.installImages to auto, then try again.`,
    };
  return { kind: 'install', pkg };
}

function freeBytes(path: string): number | null {
  try {
    const disk = statfsSync(path);
    return disk.bavail * disk.bsize;
  } catch {
    return null;
  }
}

function licenseAccepted(sdk: string): boolean {
  try {
    return readFileSync(join(sdk, 'licenses', 'android-sdk-license'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

// sdkmanager (AbstractPackageOperation in cmdline-tools' tools.repository.jar) keeps `.installer/.installData` in a
// package's destination while it installs and deletes it when done; package.xml is present in a complete package.
function imageComplete(sdk: string, pkg: string): boolean {
  const directory = join(sdk, ...pkg.split(';'));
  return existsSync(join(directory, 'package.xml')) && !existsSync(join(directory, '.installer'));
}

function claimRoot(sdk: string): string {
  let canonical = sdk;
  try {
    canonical = realpathSync(sdk);
  } catch {}
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(configDir(), 'android-sdk-installs', key);
}

function failureLine(text: string): string {
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('['));
  return lines.find((line) => /^(Warning|Error):/.test(line)) ?? lines.at(-1) ?? '';
}

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

type InstallResult = { ok: true; installed: boolean } | ({ ok: false } & SystemImageRefusal);

const refuse = (message: string, remedy: string, code = 'STIM_NO_DEVICE'): InstallResult => ({
  ok: false,
  code,
  message,
  remedy,
});

function outputOf(error: unknown): string {
  const field = (name: string): string => {
    const value: unknown = error && typeof error === 'object' ? Reflect.get(error, name) : undefined;
    return typeof value === 'string' ? value : '';
  };
  return `${field('stdout')}\n${field('stderr')}`;
}

/** Makes sure the system image an owned AVD needs is installed. `installed` is true when it was missing at the start of this call, whichever run installed it. */
export async function ensureSystemImage({
  requested,
  policy,
  env,
  signal,
  note,
}: {
  requested: string | null;
  policy: AndroidImageInstallPolicy;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  note: (line: string) => void;
}): Promise<{ ok: true; installed: boolean } | ({ ok: false } & SystemImageRefusal)> {
  const decision = decideSystemImage({ requested, installed: listInstalledSystemImages(undefined, env), policy, env });
  if (decision.kind === 'refuse')
    return { ok: false, code: decision.code, message: decision.message, remedy: decision.remedy };
  if (decision.kind === 'installed') return { ok: true, installed: false };
  const result = await installSystemImage({ pkg: decision.pkg, env, signal, note });
  return result.ok ? { ok: true, installed: true } : result;
}

const licensesRefusal = (pkg: string, sdk: string, env: NodeJS.ProcessEnv): SystemImageRefusal => ({
  code: 'STIM_NO_DEVICE',
  message: `The Android SDK licenses ${pkg} needs are not accepted in ${sdk}, and Stim does not accept them for you.`,
  remedy: `Run \`${sdkmanagerCommand('--licenses', env)}\` on this machine and accept them, then try again.`,
});

/** Why this machine cannot install `pkg` now, checked before any download: no sdkmanager, no accepted license, or too little disk. */
export function systemImageInstallProblem(pkg: string, env: NodeJS.ProcessEnv): SystemImageRefusal | null {
  const sdk = androidHome(env);
  if (!isAbsolute(androidToolPath('sdkmanager', process.platform, env)))
    return {
      code: 'STIM_NO_DEVICE',
      message: `The Android SDK command-line tools are not installed in ${sdk}, so Stim cannot install ${pkg}.`,
      remedy:
        'Install "Android SDK Command-line Tools (latest)" from the SDK Manager in Android Studio, then try again.',
    };
  if (!licenseAccepted(sdk)) return licensesRefusal(pkg, sdk, env);
  const free = freeBytes(sdk);
  if (free !== null && free < IMAGE_INSTALL_FREE_BYTES)
    return {
      code: 'STIM_NO_DEVICE',
      message: `${gb(free)} GB free on the volume of ${sdk}, needs ${gb(IMAGE_INSTALL_FREE_BYTES)} GB to download and unpack ${pkg}.`,
      remedy: `Free space on that volume (\`stim gc\` lists what Stim can reclaim), or run \`${sdkmanagerCommand(`--install "${pkg}"`, env)}\` yourself, then try again.`,
    };
  return null;
}

/**
 * Installs one system image with the SDK's own sdkmanager, never accepting a license for the user. One install runs per
 * SDK root and Stim home: a second caller waits for the first and returns without installing when the image is there.
 */
export async function installSystemImage({
  pkg,
  env,
  signal,
  note,
}: {
  pkg: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  note: (line: string) => void;
}): Promise<{ ok: true; installed: boolean } | ({ ok: false } & SystemImageRefusal)> {
  const sdk = androidHome(env);
  const tool = androidToolPath('sdkmanager', process.platform, env);
  const manual = sdkmanagerCommand(`--install "${pkg}"`, env);
  const licenses = (): InstallResult => ({ ok: false, ...licensesRefusal(pkg, sdk, env) });

  const root = claimRoot(sdk);
  let claim: ClaimHandle | undefined;
  let waited = false;
  while (!claim) {
    try {
      const attempt = tryAcquireClaim({
        root,
        mode: 'exclusive',
        details: { sdk, package: pkg },
        label: 'Android system image install',
      });
      claim = attempt.acquired;
    } catch (error) {
      const failure = claimFailure(error, null);
      if (failure) return refuse(failure.message, failure.remedy, failure.code);
      throw error;
    }
    if (claim) break;
    if (!waited) note(`waiting for another Stim process that installs an Android system image in ${sdk}`);
    waited = true;
    await cancellableSleep(CLAIM_POLL_MS, { signal, what: 'wait for the Android system image install' });
  }
  const held = claim;
  let unresolved = false;
  try {
    if (imageComplete(sdk, pkg)) return { ok: true, installed: false };
    const problem = systemImageInstallProblem(pkg, env);
    if (problem) return { ok: false, ...problem };
    note(`installing ${pkg} with sdkmanager (about 2 GB)`);
    let output: string;
    markClaimChildPending(held);
    try {
      output = await getExecutor().runFileAsync(tool, [`--sdk_root=${sdk}`, '--install', pkg], {
        timeoutMs: IMAGE_INSTALL_TIMEOUT_MS,
        input: 'n\n',
        signal,
        containProcessTree: true,
        onSpawn: (child) => {
          if (child.pid === undefined) return;
          const captured = captureProcessIdentity(child.pid);
          if (!captured.ok) throw new Error(`Cannot record the sdkmanager process: ${captured.reason}`);
          setClaimChild(held, { pid: child.pid, processToken: captured.token });
        },
      });
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) {
        unresolved = true;
        throw error;
      }
      signal?.throwIfAborted();
      const text = outputOf(error);
      if (LICENSE_NOT_ACCEPTED.test(text)) return licenses();
      return refuse(
        `sdkmanager could not install ${pkg}: ${failureLine(text) || (error instanceof Error ? error.message : String(error))}`,
        `Run \`${manual}\` on this machine to see the full error, then try again.`,
      );
    } finally {
      if (!unresolved) clearClaimChild(held);
    }
    if (LICENSE_NOT_ACCEPTED.test(output)) return licenses();
    const directory = join(sdk, ...pkg.split(';'));
    if (!imageComplete(sdk, pkg))
      return refuse(
        `sdkmanager finished without installing ${pkg}: ${failureLine(output) || 'it printed no error'}`,
        `Run \`${manual}\` on this machine to see the full output, then try again.`,
      );
    await recordInstalledSystemImageAsync(realpathSync(directory));
    return { ok: true, installed: true };
  } finally {
    if (!unresolved) releaseClaim(held);
  }
}
