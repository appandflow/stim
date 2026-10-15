import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { settingDefinition, settingValueError } from '@stim-cli/core/state';
import { getExecutor, type Executor } from '../exec.ts';
import { createLineReader } from '../process-output.ts';
import { settingValueAt } from '../workspace/settings.ts';
import {
  parsePlist,
  parseProvisioningProfilePlist,
  type ProvisioningProfile,
  type SigningIdentity,
} from './ios-profile.ts';
import { decodeProvisioningProfile } from './ios-signing.ts';
import { xcodebuildArgs, type XcodeProject } from './xcode.ts';

export interface ProvisionRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type ProvisionAuth =
  | { kind: 'xcode-account' }
  | { kind: 'api-key'; keyPath: string; keyId: string; issuerId: string };

const KEY_SETTINGS_REMEDY =
  'Set all three with `stim settings set <key> <value> --scope machine` (ios.appStoreConnectKeyPath, ios.appStoreConnectKeyId, ios.appStoreConnectIssuerId), or export STIM_ASC_KEY_PATH, STIM_ASC_KEY_ID and STIM_ASC_ISSUER_ID; unset all three to use the Xcode account instead.';

type KeySetting = { value: string; source: string } | { missing: string } | ProvisionRefusal;

function keySetting(key: string, machine: unknown, env: NodeJS.ProcessEnv): KeySetting {
  const definition = settingDefinition(key);
  const envName = definition?.env;
  const fromEnv = envName ? env[envName] : undefined;
  const value = fromEnv || settingValueAt(machine, key);
  if (value === undefined || value === '') return { missing: key };
  const problem = definition ? settingValueError(definition, value) : null;
  if (problem !== null || typeof value !== 'string') {
    return {
      code: 'STIM_BAD_ARG',
      message: `${fromEnv ? envName : key} is not valid: expected ${problem ?? 'a string'}. Stim does not print its value.`,
      remedy: KEY_SETTINGS_REMEDY,
    };
  }
  return { value, source: fromEnv && envName ? envName : key };
}

/** Each value comes from its environment variable when that is set and non-empty, otherwise from the machine config. */
export function provisionAuth(
  machine: unknown,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): ProvisionAuth | ProvisionRefusal {
  const keyPath = keySetting('ios.appStoreConnectKeyPath', machine, env);
  const keyId = keySetting('ios.appStoreConnectKeyId', machine, env);
  const issuerId = keySetting('ios.appStoreConnectIssuerId', machine, env);
  const read = [keyPath, keyId, issuerId];
  for (const each of read) if ('code' in each) return each;
  const missing = read.flatMap((each) => ('missing' in each ? [each.missing] : []));
  if (missing.length === read.length) return { kind: 'xcode-account' };
  if (!('value' in keyPath && 'value' in keyId && 'value' in issuerId)) {
    return {
      code: 'STIM_BAD_ARG',
      message: `An App Store Connect API key needs a key path, key ID and issuer ID; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      remedy: KEY_SETTINGS_REMEDY,
    };
  }
  if (!fileExists(keyPath.value)) {
    return {
      code: 'STIM_BAD_ARG',
      message: `The App Store Connect API key file that ${keyPath.source} names does not exist.`,
      remedy: `Point ${keyPath.source} at the AuthKey_<KEY_ID>.p8 file App Store Connect gave you. ${KEY_SETTINGS_REMEDY}`,
    };
  }
  return { kind: 'api-key', keyPath: keyPath.value, keyId: keyId.value, issuerId: issuerId.value };
}

/** Replaces the key path, which can name a private key's location, wherever xcodebuild echoes it. */
export function redactKeyPath(text: string, auth: ProvisionAuth): string {
  return auth.kind === 'api-key' ? text.replaceAll(auth.keyPath, '<ios.appStoreConnectKeyPath>') : text;
}

export function describeAuth(auth: ProvisionAuth): string {
  return auth.kind === 'api-key'
    ? `the App Store Connect API key ${auth.keyId}`
    : 'the Apple account signed in to Xcode > Settings > Accounts';
}

export function provisionXcodebuildArgs({
  project,
  scheme,
  configuration,
  udid,
  derivedDataPath,
  auth,
}: {
  project: XcodeProject;
  scheme: string;
  configuration: string;
  udid: string;
  derivedDataPath: string;
  auth: ProvisionAuth;
}): string[] {
  return xcodebuildArgs({
    project,
    scheme,
    configuration,
    sdk: 'iphoneos',
    udid,
    derivedDataPath,
    extraArgs: [
      '-allowProvisioningUpdates',
      '-allowProvisioningDeviceRegistration',
      ...(auth.kind === 'api-key'
        ? [
            '-authenticationKeyPath',
            auth.keyPath,
            '-authenticationKeyID',
            auth.keyId,
            '-authenticationKeyIssuerID',
            auth.issuerId,
          ]
        : []),
    ],
  });
}

export interface SigningTarget {
  target: string;
  bundleId: string;
  platform: string;
  team: string | null;
  automatic: boolean;
}

/** Every target of the scheme that xcodebuild signs with a provisioning profile, on any platform; null when the output is not JSON. */
export function parseSigningTargets(output: unknown): SigningTarget[] | null {
  let items: unknown;
  try {
    items = JSON.parse(String(output));
  } catch {
    return null;
  }
  const targets: SigningTarget[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const raw: unknown = item && typeof item === 'object' && 'buildSettings' in item ? item.buildSettings : null;
    if (!raw || typeof raw !== 'object') continue;
    const settings: Record<string, unknown> = { ...raw };
    if (
      settings.CODE_SIGNING_ALLOWED !== 'YES' ||
      settings.PROVISIONING_PROFILE_REQUIRED !== 'YES' ||
      typeof settings.PRODUCT_BUNDLE_IDENTIFIER !== 'string' ||
      settings.PRODUCT_BUNDLE_IDENTIFIER === ''
    )
      continue;
    const team = typeof settings.DEVELOPMENT_TEAM === 'string' ? settings.DEVELOPMENT_TEAM.trim() : '';
    targets.push({
      target: typeof settings.TARGET_NAME === 'string' ? settings.TARGET_NAME : settings.PRODUCT_BUNDLE_IDENTIFIER,
      bundleId: settings.PRODUCT_BUNDLE_IDENTIFIER,
      platform: typeof settings.PLATFORM_NAME === 'string' ? settings.PLATFORM_NAME : 'unknown',
      team: team || null,
      automatic: settings.CODE_SIGN_STYLE !== 'Manual',
    });
  }
  return targets;
}

export function signingTargetsRefusal(
  targets: readonly SigningTarget[],
  { scheme, configuration }: { scheme: string; configuration: string },
): ProvisionRefusal | null {
  if (targets.length === 0) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: `Scheme ${scheme} builds no target that needs a provisioning profile in its ${configuration} configuration, so there is nothing to provision.`,
      remedy: 'Pass the app scheme with --scheme, or set ios.scheme, and check the configuration with --configuration.',
    };
  }
  const teamless = targets.filter((target) => target.team === null);
  if (teamless.length > 0) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: `No development team is set for ${teamless.map((t) => `${t.target} (${t.bundleId})`).join(', ')} in the ${configuration} configuration. Stim provisions for the team the build signs with, and a later \`stim ios --device\` build uses the project's team too.`,
      remedy:
        'Choose a team in Xcode > Signing & Capabilities, or for an Expo app set expo.ios.appleTeamId in the app config and run `npx expo prebuild -p ios` again, then retry.',
    };
  }
  const manual = targets.filter((target) => !target.automatic);
  if (manual.length > 0) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: `${manual.map((t) => `${t.target} (${t.bundleId})`).join(', ')} use${manual.length === 1 ? 's' : ''} manual signing in the ${configuration} configuration, and xcodebuild creates or refreshes profiles only for automatic signing.`,
      remedy:
        'Turn on Automatically manage signing in Xcode > Signing & Capabilities, or create the Development profile in the Apple Developer portal and install it.',
    };
  }
  return null;
}

export interface ProvisionDevice {
  udid: string;
  name: string;
}

export function provisionPlanLines({
  device,
  targets,
  auth,
  scheme,
  configuration,
}: {
  device: ProvisionDevice;
  targets: readonly SigningTarget[];
  auth: ProvisionAuth;
  scheme: string;
  configuration: string;
}): string[] {
  const teams = [...new Set(targets.map((target) => target.team))].join(', ');
  return [
    `This changes the Apple Developer account of team ${teams}, through ${describeAuth(auth)}:`,
    `  - registers ${device.name} (${device.udid}) as a development device, when the team does not list it yet;`,
    ...targets.map(
      (target) =>
        `  - creates or refreshes the ${target.platform === 'iphoneos' ? 'iOS App' : `${target.platform}`} Development profile for ${target.bundleId} (target ${target.target}, scheme ${scheme}, ${configuration}) so it lists that device;`,
    ),
    '  - creates an Apple Development certificate for this Mac when the keychain holds none for the team.',
    `Those are all the targets scheme ${scheme} signs with a profile. It runs xcodebuild with -allowProvisioningUpdates -allowProvisioningDeviceRegistration for that scheme only and stops it once signing resolves; it installs nothing.`,
  ];
}

const TASK_LINE = /^[A-Z][A-Za-z]+ /;
const DIAGNOSTIC = /\b(?:error|warning|note):/;

/**
 * xcodebuild resolves signing while planning and runs build tasks only when planning succeeded: it prints
 * `Build description path:`, then either the planning errors and `** BUILD FAILED **`, or the first task such as
 * `CreateBuildDirectory`. An `error:` line therefore decides nothing on its own; the first task does.
 */
export function createPlanningWatch(): (line: string) => boolean {
  let state: 'planning' | 'planned' | 'ended' = 'planning';
  return (line) => {
    if (state === 'ended') return false;
    if (line.startsWith('** ')) {
      state = 'ended';
      return false;
    }
    if (line.startsWith('Build description path: ')) {
      state = 'planned';
      return false;
    }
    return state === 'planned' && TASK_LINE.test(line) && !DIAGNOSTIC.test(line);
  };
}

function errorText(line: string): string {
  const at = line.indexOf('error: ');
  return (at < 0 ? line : line.slice(at + 'error: '.length))
    .replace(/ \(in target '.*' from project '.*'\)$/, '')
    .trim();
}

export function provisionFailure(lines: readonly string[], auth: ProvisionAuth, teams: string): ProvisionRefusal {
  const errors = lines.filter((line) => /\berror: /.test(line)).map(errorText);
  const unique = [...new Set(errors)];
  const has = (pattern: RegExp) => unique.find((text) => pattern.test(text));
  if (has(/^No Accounts\b/)) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message:
        auth.kind === 'api-key'
          ? `xcodebuild reported No Accounts although it was given ${describeAuth(auth)}.`
          : 'xcodebuild has no Apple account to provision with: Xcode has no account signed in, and no App Store Connect API key is set.',
      remedy: `Sign in under Xcode > Settings > Accounts with an Apple ID on team ${teams}, or ${KEY_SETTINGS_REMEDY.charAt(0).toLowerCase()}${KEY_SETTINGS_REMEDY.slice(1)} Then run \`stim device provision ios\` again.`,
    };
  }
  const noTeam = has(/^No Account for Team\b/);
  const quoted = (text: string) => redactKeyPath(text, auth);
  if (noTeam) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: `Xcode cannot reach team ${teams} through ${describeAuth(auth)}: ${quoted(noTeam)}`,
      remedy: `Sign in to Xcode with an Apple ID that belongs to team ${teams}, or use an App Store Connect API key issued by that team. If the project names the wrong team, fix it in Xcode > Signing & Capabilities.`,
    };
  }
  const rejected = has(/Communication with Apple failed.*\b401\b/);
  if (rejected) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: `Apple rejected ${describeAuth(auth)}: ${quoted(rejected)}`,
      remedy:
        auth.kind === 'api-key'
          ? 'Check that the key ID and issuer ID match the .p8 file and that the key is still active under App Store Connect > Users and Access > Integrations.'
          : 'Sign in again under Xcode > Settings > Accounts.',
    };
  }
  if (has(/Unable to find a destination matching/)) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: 'xcodebuild could not use the phone as a destination.',
      remedy:
        'Unlock the phone, check that it is paired and has Developer Mode on, and that `xcrun devicectl list devices` lists it, then retry.',
    };
  }
  return {
    code: 'STIM_PROVISION_FAILED',
    message: unique.length
      ? `xcodebuild could not provision signing: ${redactKeyPath(unique.slice(0, 5).join(' | '), auth)}`
      : 'xcodebuild exited before signing resolved and printed no error.',
    remedy:
      'Fix what xcodebuild reports, or open the workspace in Xcode, select the phone and build once, which provisions the same way after asking for an account.',
  };
}

export interface InstalledProfile {
  file: string;
  mtimeMs: number;
  profile: ProvisioningProfile | null;
  applicationIdentifier: string | null;
}

export function profileDirectories(home: string = homedir()): string[] {
  return [
    join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
    join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
  ];
}

export function listProfileFiles(dirs: readonly string[]): Map<string, number> {
  const files = new Map<string, number>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.mobileprovision')) continue;
      try {
        files.set(join(dir, name), statSync(join(dir, name)).mtimeMs);
      } catch {}
    }
  }
  return files;
}

function applicationIdentifierOf(xml: string): string | null {
  const root = parsePlist(xml);
  const entitlements = root && typeof root === 'object' && 'Entitlements' in root ? root.Entitlements : null;
  const value =
    entitlements && typeof entitlements === 'object' && 'application-identifier' in entitlements
      ? entitlements['application-identifier']
      : null;
  return typeof value === 'string' ? value : null;
}

export async function readInstalledProfiles(
  files: Map<string, number>,
  { exec = null }: { exec?: Executor | null } = {},
): Promise<InstalledProfile[]> {
  const out: InstalledProfile[] = [];
  for (const [file, mtimeMs] of files) {
    const xml = await decodeProvisioningProfile(file, { exec });
    out.push({
      file,
      mtimeMs,
      profile: xml === null ? null : parseProvisioningProfilePlist(xml),
      applicationIdentifier: xml === null ? null : applicationIdentifierOf(xml),
    });
  }
  return out;
}

function coversBundle(
  applicationIdentifier: string | null,
  team: string,
  bundleId: string,
): 'exact' | 'wildcard' | null {
  if (applicationIdentifier === `${team}.${bundleId}`) return 'exact';
  if (applicationIdentifier?.endsWith('*')) {
    const prefix = applicationIdentifier.slice(0, -1);
    if (`${team}.${bundleId}`.startsWith(prefix)) return 'wildcard';
  }
  return null;
}

interface ProfileOutcome {
  bundleId: string;
  profile: { name: string | null; uuid: string | null; expires: string; devices: number } | null;
  installed: boolean;
}

export interface ProvisionChanges {
  profiles: ProfileOutcome[];
  identities: SigningIdentity[];
}

export function provisionChanges({
  before,
  after,
  targets,
  udid,
  identitiesBefore,
  identitiesAfter,
  now,
}: {
  before: Map<string, number>;
  after: readonly InstalledProfile[];
  targets: readonly SigningTarget[];
  udid: string;
  identitiesBefore: readonly SigningIdentity[];
  identitiesAfter: readonly SigningIdentity[];
  now: number;
}): ProvisionChanges {
  const profiles = targets.map((target): ProfileOutcome => {
    const team = target.team;
    const matches = after
      .flatMap((entry) => {
        const profile = entry.profile;
        const expires = profile?.expirationDate;
        const devices = profile?.provisionedDevices;
        if (!profile || !team || profile.teamIdentifier !== team || !profile.getTaskAllow) return [];
        if (!expires || expires.getTime() <= now) return [];
        if (!devices?.some((device) => device.toLowerCase() === udid.toLowerCase())) return [];
        const fit = coversBundle(entry.applicationIdentifier, team, target.bundleId);
        return fit ? [{ entry, profile, fit, expires, devices }] : [];
      })
      .toSorted(
        (a, b) => Number(b.fit === 'exact') - Number(a.fit === 'exact') || b.expires.getTime() - a.expires.getTime(),
      );
    const best = matches[0];
    if (!best) return { bundleId: target.bundleId, profile: null, installed: false };
    return {
      bundleId: target.bundleId,
      profile: {
        name: best.profile.name,
        uuid: best.profile.uuid,
        expires: best.expires.toISOString(),
        devices: best.devices.length,
      },
      installed: before.get(best.entry.file) !== best.entry.mtimeMs,
    };
  });
  const known = new Set(identitiesBefore.map((identity) => identity.sha1));
  return { profiles, identities: identitiesAfter.filter((identity) => !known.has(identity.sha1)) };
}

export function provisionReportLines(changes: ProvisionChanges, device: ProvisionDevice, resolved = true): string[] {
  const lines = changes.profiles.flatMap((outcome) => {
    if (outcome.profile) {
      if (!resolved && !outcome.installed) return [];
      return [
        `${outcome.bundleId}: ${outcome.installed ? 'installed' : 'already had'} profile "${outcome.profile.name ?? outcome.profile.uuid}" (${outcome.profile.uuid}), which lists ${device.name} among ${outcome.profile.devices} device(s) and expires ${outcome.profile.expires.slice(0, 10)}.`,
      ];
    }
    return resolved
      ? [
          `${outcome.bundleId}: xcodebuild resolved signing, but no installed Development profile listing ${device.udid} was found under ${profileDirectories().join(' or ')}.`,
        ]
      : [];
  });
  for (const identity of changes.identities) lines.push(`New signing identity in the keychain: ${identity.name}.`);
  return lines;
}

export interface ProvisioningRun {
  resolved: boolean;
  lines: string[];
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  error?: Error;
}

export const PROVISION_TIMEOUT_MS: number = 15 * 60_000;
/** How long xcodebuild gets after SIGINT before SIGTERM, and after SIGTERM before SIGKILL. */
const PROVISION_STOP_GRACE_MS: { interrupt: number; terminate: number } = {
  interrupt: 10_000,
  terminate: 5_000,
};

export async function runProvisioningBuild({
  args,
  cwd,
  env,
  signal,
  exec = null,
  timeoutMs = PROVISION_TIMEOUT_MS,
  graceMs = PROVISION_STOP_GRACE_MS,
  onChild = () => () => {},
}: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  exec?: Executor | null;
  timeoutMs?: number;
  graceMs?: { interrupt: number; terminate: number };
  onChild?: (child: ChildProcess) => () => void;
}): Promise<ProvisioningRun> {
  const executor = exec || getExecutor();
  const lines: string[] = [];
  const executing = createPlanningWatch();
  let resolved = false;
  let timedOut = false;
  let cancelled = false;
  let child: ChildProcess;
  try {
    child = executor.spawn('xcodebuild', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, NSUnbufferedIO: 'YES', FORCE_COLOR: '0' },
    });
  } catch (error) {
    return {
      resolved: false,
      lines,
      code: null,
      timedOut,
      cancelled,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const forget = onChild(child);
  const escalations: NodeJS.Timeout[] = [];
  let stopping = false;
  const stop = (first: 'SIGINT' | 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    child.kill(first);
    const terminateAt = first === 'SIGINT' ? graceMs.interrupt : 0;
    if (first === 'SIGINT') escalations.push(setTimeout(() => child.kill('SIGTERM'), terminateAt));
    escalations.push(setTimeout(() => child.kill('SIGKILL'), terminateAt + graceMs.terminate));
  };
  const onLine = (line: string) => {
    lines.push(line);
    if (!resolved && !stopping && executing(line)) {
      resolved = true;
      stop('SIGINT');
    }
  };
  const out = createLineReader(onLine);
  const err = createLineReader(onLine);
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk) => out.push(chunk));
  child.stderr?.on('data', (chunk) => err.push(chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    stop('SIGTERM');
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop(signal?.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const escalation of escalations) clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      forget();
      out.flush();
      err.flush();
      resolve({
        resolved: resolved || (code === 0 && !cancelled && !timedOut),
        lines,
        code,
        timedOut,
        cancelled,
        ...(error ? { error } : {}),
      });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (error) => finish(null, error));
  });
}
