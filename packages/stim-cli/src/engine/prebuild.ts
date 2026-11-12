import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { git, gitAsync } from '../workspace/git.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';
import { declareSpawnsOn, spawnDeclared, stopDeclaringSpawnsOn } from './spawn-claims.ts';
import { remoteCliInvocation } from './node-cli.ts';
import { detectIsExpo } from '../workspace/project.ts';
import { expoBinPath, expoBinRefusal, expoSdkMajor, expoTelemetryEnv } from '../stimd/metro/server-expo.ts';
import {
  readWorkspaceState,
  updateWorkspaceState,
  type WorkspaceState,
  withWorkspaceStateLockAsync,
} from '../workspace/workspace-state.ts';
import { ambientContext, workspaceName, type StimContext } from '@stim-cli/core';
import { operationState } from './operation-state.ts';
import { WorkspaceProcessCleanupError, workspaceProcessLockPath } from './workspace-process-lock.ts';
import { isClaimUnavailable, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { processContext } from '../cli-operation.ts';
import { readFingerprint } from '../fingerprint-precompute.ts';
import { FINGERPRINT_SCHEMA } from '@stim-cli/core/state';
import type { NativeMode } from '../fingerprint/key.ts';
import { shortHash } from '../command-output.ts';
import {
  fingerprintInputsSetting,
  resolveAndroidLayout,
  resolveIosProjectDir,
  resolveProjectSettingsAsync,
  type SettingsObject,
} from '../workspace/settings.ts';

export const PREBUILD_ERROR = 'STIM_PREBUILD_FAILED';

const LAST_LINES = 20;

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

function nativeDirName(platform: string): string {
  return platform === 'android' ? 'android' : 'ios';
}

function nativeDir(root: string, platform: string) {
  return join(root, nativeDirName(platform));
}

export type PrebuildAction = 'none' | 'generate' | 'regenerate' | 'refuse';

function prebuildAction({
  isExpo,
  nativeDirExists,
  nativeDirFingerprinted,
  nativeDirTracked,
  generatedFrom,
  fingerprint,
  foreign,
}: {
  isExpo: boolean;
  nativeDirExists: boolean;
  nativeDirFingerprinted: boolean;
  nativeDirTracked: boolean;
  generatedFrom: string | null;
  fingerprint: string;
  foreign: boolean;
}): PrebuildAction {
  if (!isExpo) return 'none';
  if (!nativeDirExists) return nativeDirFingerprinted ? 'refuse' : 'generate';
  if (nativeDirFingerprinted || generatedFrom === fingerprint) return 'none';
  if (foreign) return 'refuse';
  return nativeDirTracked ? 'refuse' : 'regenerate';
}

function prebuildRecord(state: WorkspaceState | null): Record<string, unknown> {
  const record = state?.prebuild;
  return record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
}

function unreadableGitTracksNativeDir(error: unknown): boolean {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
  return !/not a git repository \(or any (of the parent directories|parent up to mount point)/.test(
    error instanceof Error ? error.message : String(error),
  );
}

function gitTracksNativeDir(root: string, platform: string): boolean {
  try {
    return (
      git(root, ['ls-files', '--', nativeDirName(platform)], { env: { LC_ALL: 'C', LANGUAGE: 'C' } }).trim() !== ''
    );
  } catch (error) {
    return unreadableGitTracksNativeDir(error);
  }
}

function prebuildInputs(
  root: string,
  platform: string,
  {
    isExpo,
    fingerprint,
    native,
  }: {
    isExpo: boolean;
    fingerprint: string;
    native?: NativeMode;
  },
): Omit<Parameters<typeof prebuildAction>[0], 'nativeDirTracked'> {
  const nativeDirExists = existsSync(nativeDir(root, platform));
  const fingerprinted = native === 'tracked';
  const recorded = prebuildRecord(readWorkspaceState(root))[platform];
  const status = prebuildRecordStatus(recorded, fingerprint);
  const generatedFrom = status.kind === 'current' ? status.generatedFrom : null;
  return {
    isExpo,
    nativeDirExists,
    nativeDirFingerprinted: fingerprinted,
    generatedFrom,
    foreign: status.kind === 'foreign',
    fingerprint,
  };
}

export async function planUnfingerprintedPrebuild(
  root: string,
  platform: 'ios' | 'android',
  isExpo: boolean,
  signal?: AbortSignal,
): Promise<PrebuildAction> {
  if (!isExpo) return 'none';
  const dir = nativeDir(root, platform);
  try {
    const tracked = await gitAsync(root, ['ls-files', '--', nativeDirName(platform)], { signal });
    signal?.throwIfAborted();
    if (tracked.trim()) return 'none';
  } catch (error) {
    if (error instanceof Error && 'reportCleanup' in error) throw error;
    signal?.throwIfAborted();
  }
  return existsSync(dir) ? 'refuse' : 'generate';
}

export function planPrebuild(
  root: string,
  platform: string,
  options: Parameters<typeof prebuildInputs>[2],
): PrebuildAction {
  const inputs = prebuildInputs(root, platform, options);
  return prebuildAction({
    ...inputs,
    nativeDirTracked: inputs.nativeDirExists && !inputs.nativeDirFingerprinted && gitTracksNativeDir(root, platform),
  });
}

export async function planPrebuildAsync(
  root: string,
  platform: string,
  options: Parameters<typeof prebuildInputs>[2],
  signal?: AbortSignal,
): Promise<PrebuildAction> {
  signal?.throwIfAborted();
  const inputs = prebuildInputs(root, platform, options);
  const untracked = prebuildAction({ ...inputs, nativeDirTracked: false });
  if (untracked !== 'regenerate') return untracked;
  let tracked: boolean;
  try {
    tracked =
      (
        await gitAsync(root, ['ls-files', '--', nativeDirName(platform)], {
          env: { LC_ALL: 'C', LANGUAGE: 'C' },
          signal,
        })
      ).trim() !== '';
  } catch (error) {
    signal?.throwIfAborted();
    tracked = unreadableGitTracksNativeDir(error);
  }
  return tracked ? 'refuse' : 'regenerate';
}

export function recordPrebuild(root: string, platform: string, fingerprint: string | null): void {
  updateWorkspaceState(root, (state) => ({
    ...state,
    prebuild: {
      ...prebuildRecord(state),
      [platform]: fingerprint === null ? null : { schema: FINGERPRINT_SCHEMA, hash: fingerprint },
    },
  }));
}

/** Records the prebuild fingerprint after waiting for the workspace state lock without blocking the event loop. */
export function recordPrebuildAsync(root: string, platform: string, fingerprint: string | null): Promise<void> {
  return withWorkspaceStateLockAsync(root, () => recordPrebuild(root, platform, fingerprint));
}

type NativeDirCarry = { generatedFrom: string } | { reason: string };

export type PrebuildRecordStatus =
  | { kind: 'current'; generatedFrom: string }
  | { kind: 'unfinished' }
  | { kind: 'unrecorded' }
  | { kind: 'earlier' }
  | { kind: 'foreign' }
  | { kind: 'moved'; recorded: string; current: string }
  | { kind: 'unfingerprintable'; recorded: string };

/** The first fingerprint schema whose records carry `{ schema, hash }`. */
const FIRST_RECORD_SCHEMA = 2;

/** The fingerprint Stim 1.40 recorded: 40 lowercase hex digits. */
const LEGACY_RECORD_HASH = /^[0-9a-f]{40}$/;

/**
 * A record is `earlier` when an earlier Stim wrote it: `{ schema, hash }` with an integer schema from the first one that
 * wrote records up to the one before this Stim's, or the bare 40-digit hash Stim 1.40 wrote. Such a record proves Stim
 * generated the directory but cannot be compared with the current hash. `foreign` is any other record: a higher schema,
 * or a shape no Stim wrote.
 */
export function prebuildRecordStatus(recorded: unknown, current: string | null): PrebuildRecordStatus {
  if (recorded === null) return { kind: 'unfinished' };
  if (recorded === undefined) return { kind: 'unrecorded' };
  // compat C31 until 2.1.0
  if (typeof recorded === 'string') return { kind: LEGACY_RECORD_HASH.test(recorded) ? 'earlier' : 'foreign' };
  // compat end
  if (
    typeof recorded !== 'object' ||
    !('schema' in recorded) ||
    !('hash' in recorded) ||
    typeof recorded.hash !== 'string'
  )
    return { kind: 'foreign' };
  if (
    Number.isInteger(recorded.schema) &&
    Number(recorded.schema) >= FIRST_RECORD_SCHEMA &&
    Number(recorded.schema) < FINGERPRINT_SCHEMA
  )
    return { kind: 'earlier' };
  if (recorded.schema !== FINGERPRINT_SCHEMA) return { kind: 'foreign' };
  if (current === recorded.hash) return { kind: 'current', generatedFrom: recorded.hash };
  return current
    ? { kind: 'moved', recorded: recorded.hash, current }
    : { kind: 'unfingerprintable', recorded: recorded.hash };
}

export async function readPrebuildRecord(
  appRoot: string,
  platform: string,
  operation: StimContext = processContext(appRoot),
): Promise<{ recorded: unknown; current: string | null }> {
  const recorded = prebuildRecord(readWorkspaceState(appRoot))[platform];
  if (prebuildRecordStatus(recorded, null).kind !== 'unfingerprintable') return { recorded, current: null };
  let settings: SettingsObject | null = null;
  let repoRoot = appRoot;
  try {
    const resolved = await resolveProjectSettingsAsync(appRoot, {
      env: operation.env,
      signal: operation.signal,
      declareFor: operation,
    });
    settings = resolved.settings;
    repoRoot = resolved.context.repoRoot ?? appRoot;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
    operation.signal.throwIfAborted();
    return { recorded, current: null };
  }
  let current: string | null = null;
  try {
    if (platform !== 'ios' && platform !== 'android') return { recorded, current };
    const inputs = fingerprintInputsSetting(settings);
    const computed = await readFingerprint(operation, {
      root: appRoot,
      platform,
      embedMode: 'development',
      ...(inputs === undefined ? {} : { fingerprintInputs: inputs }),
      ...(platform === 'ios'
        ? { iosProjectPath: resolveIosProjectDir(settings, appRoot).relative }
        : { androidLayout: resolveAndroidLayout(settings, appRoot, repoRoot) }),
    });
    if (computed && !('uncertain' in computed)) current = computed.hash;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
    operation.signal.throwIfAborted();
  }
  return { recorded, current };
}

/**
 * Whether a worktree may carry `appRoot`'s gitignored native directory: only when Stim's prebuild record there equals
 * the app's current native fingerprint. A directory Stim did not generate, or generated from other inputs, may come
 * from an older Expo or React Native template that a prebuild without --clean keeps.
 */
export async function nativeDirCarry(
  appRoot: string,
  platform: string,
  operation?: StimContext,
  hold?: (release: (failures: readonly unknown[]) => void) => void,
): Promise<NativeDirCarry> {
  const context = operation ?? processContext(appRoot);
  const nativeRoot = workspaceProcessLockPath(
    join(context.home, 'workspaces', workspaceName(appRoot)),
    'native-run',
    true,
  );
  const owned = [...operationState(context).declaring].some((claim) => claim.root === nativeRoot);
  if (owned) return nativeDirCarryOwned(appRoot, platform, context);
  let attempt;
  try {
    attempt = tryAcquireClaim({ root: nativeRoot, mode: 'exclusive', label: 'native-run lock' });
  } catch (error) {
    if (!isClaimUnavailable(error)) throw error;
    return {
      reason: 'the source native-run claim is busy or unresolved; generate this native directory in the target',
    };
  }
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    return {
      reason: 'the source native-run claim is busy or unresolved; generate this native directory in the target',
    };
  const claim = attempt.acquired;
  declareSpawnsOn(context, claim);
  let retained = false;
  const transferred = Boolean(hold);
  hold?.((failures) => {
    stopDeclaringSpawnsOn(context, claim);
    const keepClaim = failures.some(
      (failure) =>
        typeof failure === 'object' &&
        failure !== null &&
        'reportCleanup' in failure &&
        (!(failure instanceof WorkspaceProcessCleanupError) ||
          failure.claims.some((held) => held.path === claim.path && held.claimId === claim.claimId)),
    );
    if (!keepClaim) releaseClaim(claim);
  });
  try {
    return await nativeDirCarryOwned(appRoot, platform, context);
  } catch (error) {
    retained =
      typeof error === 'object' &&
      error !== null &&
      'reportCleanup' in error &&
      (!(error instanceof WorkspaceProcessCleanupError) || error.claims.includes(claim));
    throw error;
  } finally {
    if (!transferred) {
      stopDeclaringSpawnsOn(context, claim);
      if (!retained) releaseClaim(claim);
    }
  }
}

async function nativeDirCarryOwned(appRoot: string, platform: string, operation: StimContext): Promise<NativeDirCarry> {
  const dir = nativeDirName(platform);
  const regenerates =
    platform === 'ios'
      ? `stim ios generates ios/ fresh here and installs its Pods there, a private copy instead of a clone`
      : `stim ${platform} generates ${dir}/ fresh here`;
  const { recorded, current } = await readPrebuildRecord(appRoot, platform, operation);
  const status = prebuildRecordStatus(recorded, current);
  switch (status.kind) {
    case 'current':
      return { generatedFrom: status.generatedFrom };
    case 'unfinished':
      return { reason: `the source's last Stim prebuild of ${dir}/ did not finish; ${regenerates}` };
    case 'earlier':
      return {
        reason: `the source's ${dir}/ was generated by an earlier Stim, whose record cannot be compared; ${regenerates}`,
      };
    case 'foreign':
      return { reason: `the source's ${dir}/ has a prebuild record this Stim cannot read; ${regenerates}` };
    case 'unrecorded':
      return {
        reason: `Stim has no record of generating the source's ${dir}/, so it cannot show the directory is current; ${regenerates}`,
      };
    case 'moved':
      return {
        reason: `the source's ${dir}/ was generated from fingerprint ${shortHash(status.recorded)}, and the source is now ${shortHash(status.current)}; ${regenerates}`,
      };
    case 'unfingerprintable':
      return { reason: `could not fingerprint the source to check its ${dir}/; ${regenerates}` };
  }
}

/**
 * @expo/cli 57 made `expo prebuild` delete existing native folders by default and added `--no-clean`
 * to keep them (expo/expo#47209); earlier CLIs keep them by default and reject `--no-clean`.
 */
function keepNativeDirArgs(root: string): string[] {
  return (expoSdkMajor(root) ?? 0) >= 57 ? ['--no-clean'] : [];
}

function staleNativeDirRemedy(platform: string): string {
  const dir = nativeDirName(platform);
  return (
    `Fix what the output above reports. Stim ran \`expo prebuild\` over the existing ${dir}/ without deleting it, ` +
    `which keeps what earlier config plugins wrote there. If ${dir}/ predates a removed config plugin or an Expo SDK ` +
    `upgrade, delete ${dir}/ and run again so Stim generates it fresh.`
  );
}

export function prebuildPlanRefusal(root: string, platform: string): { code: string; message: string; remedy: string } {
  const recorded = prebuildRecord(readWorkspaceState(root))[platform];
  if (!existsSync(nativeDir(root, platform)) || prebuildRecordStatus(recorded, null).kind !== 'foreign')
    return staleNativeDirRefusal(platform);
  const dir = nativeDirName(platform);
  return {
    code: PREBUILD_ERROR,
    message: `${dir}/ has a prebuild record this Stim cannot read: it was written by a newer Stim or is damaged.`,
    remedy: `Run this project with the Stim that generated ${dir}/, or preserve any changes, move it aside to a name that does not exist yet, for example \`mv ${dir} ${dir}-${new Date().toISOString().slice(0, 10)}\`, and run again so this Stim generates it fresh.`,
  };
}

function staleNativeDirRefusal(platform: string): { code: string; message: string; remedy: string } {
  const dir = nativeDirName(platform);
  return {
    code: PREBUILD_ERROR,
    message:
      `The fingerprint leaves ${dir}/ out of the cache key, and Stim cannot show that ${dir}/ was generated ` +
      `from the current app config. Git tracks files in it, or could not say whether it does, so Stim will not ` +
      `run \`expo prebuild\` over it.`,
    remedy:
      `Stop excluding ${dir}/ from the fingerprint (check .fingerprintignore) so the cache key covers its files, ` +
      `or add ${dir}/ to .gitignore and untrack it so Stim regenerates it from the app config.`,
  };
}

function prebuildRefusal({
  isExpo,
  platform,
  nativeDirExists,
}: {
  isExpo?: unknown;
  platform: string;
  nativeDirExists?: unknown;
}): { code: string; message: string; remedy: string } | null {
  if (nativeDirExists || isExpo) return null;
  const dir = nativeDirName(platform);
  return {
    code: PREBUILD_ERROR,
    message: `This project has no ${dir}/ directory and is not an Expo (CNG) project, so Stim cannot generate one.`,
    remedy: `Check out or generate the native project (\`npx @react-native-community/cli init\` produced one originally), or add \`expo\` to the project so \`expo prebuild\` can create ${dir}/.`,
  };
}

export type RunPrebuildResult = {
  ok?: boolean;
  nativeDir?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  error?: { code: string; message: string; remedy: string };
  lastLines?: string[];
  durationMs?: number;
};

function prebuildFailure(logWriter: NdjsonWriter | null | undefined, result: RunPrebuildResult): RunPrebuildResult {
  logWriter?.write?.({
    src: 'build',
    level: 'error',
    msg: result.reason || 'Expo prebuild failed.',
    event: 'prebuild_failed',
  });
  return result;
}

export async function runPrebuild(
  root: string,
  platform: string,
  logWriter: NdjsonWriter | null | undefined,
  {
    spawnFn = null,
    now = Date.now,
    isExpo = null,
    clean = false,
  }: { spawnFn?: SpawnFn | null; now?: () => number; isExpo?: boolean | null; clean?: boolean } = {},
): Promise<RunPrebuildResult> {
  const dirExists = existsSync(nativeDir(root, platform));
  const refusal = prebuildRefusal({
    isExpo: isExpo === null ? detectIsExpo(root) : isExpo,
    platform,
    nativeDirExists: dirExists,
  });
  if (refusal) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: refusal.code,
      reason: refusal.message,
      remedy: refusal.remedy,
      error: refusal,
      lastLines: [],
    });
  }

  const bin = expoBinPath(root);
  if (!bin) {
    const binRefusal = expoBinRefusal(root, 'prebuild');
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: binRefusal.message,
      remedy: binRefusal.remedy,
      lastLines: [],
    });
  }

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const startedAt = now();
  const tail: string[] = [];
  const push = (line: unknown) => {
    const msg = stripAnsi(String(line)).trimEnd();
    if (!msg.trim()) return;
    tail.push(msg);
    if (tail.length > LAST_LINES) tail.shift();
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'prebuild' });
  };

  let child: ChildProcess;
  try {
    const invocation = remoteCliInvocation(
      bin,
      ['prebuild', '-p', platform, '--no-install', ...(clean ? ['--clean'] : dirExists ? keepNativeDirArgs(root) : [])],
      'expo',
    );
    child = spawnDeclared(ambientContext(), () =>
      spawn(invocation.file, invocation.args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...(ambientContext()?.env ?? process.env),
          ...expoTelemetryEnv(ambientContext()?.env ?? process.env),
          FORCE_COLOR: '0',
          CI: '1',
        },
      }),
    );
  } catch (err) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${(err as Error)?.message || err}`,
      lastLines: [] as string[],
    });
  }

  const outReader = createLineReader(push);
  const errReader = createLineReader(push);
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  const result = await waitForChild(child);
  outReader.flush();
  errReader.flush();
  const durationMs = now() - startedAt;

  if (result.error) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `Could not run \`expo prebuild\`: ${result.error?.message || result.error}`,
      lastLines: tail.slice(),
      durationMs,
    });
  }
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` failed (${how}).`,
      ...(dirExists && !clean ? { remedy: staleNativeDirRemedy(platform) } : {}),
      lastLines: tail.slice(),
      durationMs,
    });
  }
  if (!existsSync(nativeDir(root, platform))) {
    return prebuildFailure(logWriter, {
      failed: true,
      code: PREBUILD_ERROR,
      reason: `\`expo prebuild -p ${platform}\` succeeded but did not create ${nativeDirName(platform)}/.`,
      lastLines: tail.slice(),
      durationMs,
    });
  }
  return { ok: true, durationMs, nativeDir: nativeDir(root, platform) };
}
