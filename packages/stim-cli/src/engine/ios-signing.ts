import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { childEnvironment, killOnAbort } from '../workspace/git-read.ts';
import {
  parseProvisioningProfilePlist,
  parseSigningIdentities,
  profileGate,
  SIGNING_CODES,
  signingGate,
  type ProfileGateResult,
  type ProvisioningProfile,
  type SigningGateResult,
  type SigningIdentity,
  type SigningRefusal,
} from './ios-profile.ts';

export const EMBEDDED_PROFILE = 'embedded.mobileprovision';

const SIGNING_TIMEOUT_MS = 120_000;

function lastLines(text: unknown, count = 5): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count);
}

function errorText(error: unknown): string {
  const withOutput = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = String(withOutput?.stderr ?? '').trim();
  const stdout = String(withOutput?.stdout ?? '').trim();
  return stderr || stdout || String(withOutput?.message ?? error);
}

interface SigningToolOptions {
  exec?: Executor | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

async function signingCommand(
  file: string,
  args: string[],
  { exec, env, signal }: SigningToolOptions,
): Promise<string> {
  throwIfCancelled(signal, 'iOS signing');
  try {
    const output = await (exec || getExecutor()).runFileAsync(file, args, {
      timeoutMs: SIGNING_TIMEOUT_MS,
      ...(env ? childEnvironment(env) : {}),
      onSpawn: killOnAbort(signal),
    });
    throwIfCancelled(signal, 'iOS signing');
    return output;
  } catch (error) {
    throwIfCancelled(signal, 'iOS signing');
    throw error;
  }
}

export interface EmbeddedProfileRead {
  present: boolean;
  profile: ProvisioningProfile | null;
}

export async function readEmbeddedProfile(
  appPath: string,
  options: SigningToolOptions = {},
): Promise<EmbeddedProfileRead> {
  throwIfCancelled(options.signal, 'iOS signing');
  const path = join(appPath, EMBEDDED_PROFILE);
  if (!existsSync(path)) return { present: false, profile: null };
  const plist = await decodeProvisioningProfile(path, options);
  return { present: true, profile: plist === null ? null : parseProvisioningProfilePlist(plist) };
}

export async function decodeProvisioningProfile(
  path: string,
  options: SigningToolOptions = {},
): Promise<string | null> {
  try {
    return await signingCommand(
      '/usr/bin/openssl',
      ['smime', '-verify', '-noverify', '-inform', 'DER', '-in', path],
      options,
    );
  } catch {
    throwIfCancelled(options.signal, 'iOS signing');
    return null;
  }
}

export async function findSigningIdentities(options: SigningToolOptions = {}): Promise<SigningIdentity[]> {
  return (await probeSigningIdentities(options)) ?? [];
}

/** The keychain's code signing identities, or null when `security find-identity` itself failed. */
export async function probeSigningIdentities(options: SigningToolOptions = {}): Promise<SigningIdentity[] | null> {
  try {
    return parseSigningIdentities(
      await signingCommand('security', ['find-identity', '-v', '-p', 'codesigning'], options),
    );
  } catch {
    throwIfCancelled(options.signal, 'iOS signing');
    return null;
  }
}

export interface SigningGateOptions extends SigningToolOptions {
  appPath: string;
  udid: string | null;
  configuration?: string | null;
  pinnedName?: string | null;
  pinnedSha1?: string | null;
  now?: number;
}

export async function gateProfileForDevice(options: SigningGateOptions): Promise<ProfileGateResult> {
  const read = await readEmbeddedProfile(options.appPath, options);
  return profileGate({
    profilePresent: read.present,
    profile: read.profile,
    identities: [],
    udid: options.udid,
    configuration: options.configuration ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export async function gateAppForDevice(options: SigningGateOptions): Promise<SigningGateResult> {
  const read = await readEmbeddedProfile(options.appPath, options);
  return signingGate({
    profilePresent: read.present,
    profile: read.profile,
    identities: read.present ? await findSigningIdentities(options) : [],
    udid: options.udid,
    configuration: options.configuration ?? null,
    pinnedName: options.pinnedName ?? null,
    pinnedSha1: options.pinnedSha1 ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export type ResealMode = 'preserve-metadata' | 'entitlements' | 'no-entitlements';

export interface ResealSuccess {
  ok: true;
  identity: SigningIdentity;
  mode: ResealMode;
}

export interface ResealFailure extends SigningRefusal {
  lastLines: string[];
}

export type ResealResult = ResealSuccess | ResealFailure;

async function extractEntitlements(appPath: string, options: SigningToolOptions): Promise<string> {
  try {
    return String(await signingCommand('codesign', ['-d', '--entitlements', '-', '--xml', appPath], options)).trim();
  } catch {
    throwIfCancelled(options.signal, 'iOS signing');
    return '';
  }
}

export async function resealBundle({
  appPath,
  identity,
  ...options
}: SigningToolOptions & {
  appPath: string;
  identity: SigningIdentity;
}): Promise<ResealResult> {
  const signAs = identity.sha1 || identity.name;
  let mode: ResealMode = 'preserve-metadata';
  let preserveError: unknown = null;
  try {
    await signingCommand(
      'codesign',
      ['--force', '--sign', signAs, '--preserve-metadata=identifier,entitlements,flags,runtime', appPath],
      options,
    );
  } catch (error) {
    throwIfCancelled(options.signal, 'iOS signing');
    preserveError = error;
  }

  let tempDir: string | null = null;
  if (preserveError) {
    const entitlements = await extractEntitlements(appPath, options);
    const args = ['--force', '--sign', signAs];
    if (entitlements !== '') {
      tempDir = mkdtempSync(join(tmpdir(), 'stim-entitlements-'));
      const plist = join(tempDir, 'entitlements.plist');
      writeFileSync(plist, `${entitlements}\n`, 'utf-8');
      args.push('--entitlements', plist);
      mode = 'entitlements';
    } else {
      mode = 'no-entitlements';
    }
    args.push(appPath);
    try {
      await signingCommand('codesign', args, options);
    } catch (error) {
      throwIfCancelled(options.signal, 'iOS signing');
      return {
        ok: false,
        code: SIGNING_CODES.codesignFailed,
        reason: `codesign could not re-seal ${appPath} with "${identity.name}": ${errorText(error)}`,
        remedy: `Unlock the login keychain (\`security unlock-keychain\`) and confirm exactly one identity matches "${identity.name}".`,
        lastLines: [...lastLines(errorText(preserveError)), ...lastLines(errorText(error))],
      };
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  try {
    await signingCommand('codesign', ['--verify', '--strict', appPath], options);
  } catch (error) {
    throwIfCancelled(options.signal, 'iOS signing');
    return {
      ok: false,
      code: SIGNING_CODES.codesignFailed,
      reason: `codesign --verify --strict rejected ${appPath} after re-sealing it with "${identity.name}": ${errorText(error)}`,
      remedy:
        'The bundle signed but did not seal. Delete the cached artifact with `stim gc --delete` and build fresh, then retry.',
      lastLines: lastLines(errorText(error)),
    };
  }

  return { ok: true, identity, mode };
}

export async function sealAppForDevice(options: SigningGateOptions): Promise<ResealResult> {
  const gate = await gateAppForDevice(options);
  if (!gate.ok) return { ...gate, lastLines: [] };
  return resealBundle({ ...options, identity: gate.identity });
}
