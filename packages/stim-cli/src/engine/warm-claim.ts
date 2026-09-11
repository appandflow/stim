import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { getConfigDir } from '../config.ts';
import { captureProcessIdentity } from '../process-identity.ts';
import {
  CLAIM_PATH_NOT_A_DIRECTORY,
  claimRemoveCommand,
  clearClaimChild,
  isClaimRefusal,
  isClaimUnavailable,
  markClaimChildPending,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  settleClaim,
  tryAcquireClaim,
  type ClaimAttempt,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';

type WarmPhase = 'refresh' | 'copy';

const WARM_CLAIM_LABEL = 'worktree warm';
const WARM_CLAIM_POLL_MS = 250;
const WARM_CLAIM_PROGRESS_MS = 30_000;
const WARM_CLAIM_CEILING_MS = 90 * 60 * 1000;
const INSTALLER_POLL_MS = 50;
// An installer's process group empties in milliseconds once the manager itself has exited; this is the
// bound on a descendant that never does, and exceeding it keeps the claim rather than freeing it.
const INSTALLER_CEILING_MS = 5 * 60 * 1000;

interface WarmClaimHolder {
  pid: number;
  phase: WarmPhase;
}

export interface WarmClaimWait {
  waitedMs: number;
  holder: WarmClaimHolder | null;
}

/**
 * The installer a refresh spawns can outlive the Stim process that started it, so the claim records it
 * as its child: declared before the spawn, recorded once its identity is known, and released only once
 * the whole process group it leads is gone. A package manager's postinstall writer is a member of that
 * group, so the direct child's exit says nothing about whether anything is still writing.
 */
export interface InstallerClaim {
  declare: () => void;
  record: (pid: number | null) => void;
  /** Resolves once nothing that install spawned is running. `settled` is false when one still is, and the
   * claim then stays held: nothing may copy, and this process must not release it. */
  settle: () => Promise<{ settled: boolean; pid: number | null; waitedMs: number }>;
}

export interface WarmClaimHold {
  wait: WarmClaimWait;
  installer: InstallerClaim;
}

export interface WarmClaimOptions {
  repositoryRoot: string;
  phase: WarmPhase;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  progressMs?: number;
  ceilingMs?: number;
  out?: (line: string) => void;
}

export const NO_INSTALLER_CLAIM: InstallerClaim = {
  declare: () => {},
  record: () => {},
  settle: async () => ({ settled: true, pid: null, waitedMs: 0 }),
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function warmClaimsDir(): string {
  return join(getConfigDir(), 'warm-locks');
}

export function warmClaimPath(repositoryRoot: string): string {
  return join(warmClaimsDir(), `${workspaceName(repositoryRoot)}.lock`);
}

function warmCommand(phase: WarmPhase): string {
  return phase === 'refresh' ? 'stim worktree warm --refresh' : 'stim worktree warm';
}

function asHolder(holder: ClaimHolder): WarmClaimHolder {
  return { pid: holder.owner.pid, phase: holder.mode === 'exclusive' ? 'refresh' : 'copy' };
}

function waitingLine(holder: WarmClaimHolder, elapsedMs: number): string {
  return phaseLine(
    'lock',
    `waiting on ${warmCommand(holder.phase)} (pid ${holder.pid}, ${formatElapsed(elapsedMs)} elapsed)`,
  );
}

export function warmClaimAcquiredLine(wait: WarmClaimWait): string {
  if (!wait.holder || wait.waitedMs <= 0) return phaseLine('lock', 'acquired');
  return phaseLine(
    'lock',
    `acquired (waited ${formatElapsed(wait.waitedMs)} for ${warmCommand(wait.holder.phase)} pid ${wait.holder.pid})`,
  );
}

export function warmClaimUnavailableLine(reason: string): string {
  return phaseLine('lock', `unavailable (${reason}); copying without it`);
}

/**
 * The reason a copy may proceed without the claim, or null when it must refuse. Plain `warm` worked on an
 * unwritable STIM_HOME before any claim existed and only reads, so the states in which no claim can be
 * recorded at all degrade to an unsynchronised copy: no process identity, a claim store the filesystem
 * rejects, and a claim store whose own path holds a file. A claim record Stim cannot resolve and a wait
 * that ran out are refusals: neither state can exist unless the claim does, so refusing them takes
 * nothing away.
 */
export function warmClaimDegradation(error: unknown): string | null {
  if (isClaimUnavailable(error)) return error.message;
  if (isClaimRefusal(error)) {
    return error.reason === CLAIM_PATH_NOT_A_DIRECTORY ? `${error.claimPath}: ${error.reason}` : null;
  }
  const code = (error as { code?: string })?.code;
  if (typeof code === 'string' && code.startsWith('STIM_')) return null;
  return (error as Error)?.message ?? String(error);
}

export type WarmClaimBlocker =
  | { kind: 'refresh'; holder: WarmClaimHolder }
  | { kind: 'unresolved'; path: string; reason: string };

/**
 * What a copy that could not record a claim of its own would overlap if it went ahead anyway. Reading the
 * claim set classifies without writing anything and without refusing, so it works in exactly the states
 * that made the claim unrecordable -- a read-only STIM_HOME included. It is a read before a copy rather
 * than a held claim, so a refresh that starts after it is not covered; it closes the window in which one
 * is already installing, which is the window a refresh actually occupies.
 */
export function warmClaimBlocker(repositoryRoot: string): WarmClaimBlocker | null {
  const survey = readClaimSet(warmClaimPath(repositoryRoot));
  const refresh = survey.live.find((holder) => holder.mode === 'exclusive');
  if (refresh) return { kind: 'refresh', holder: asHolder(refresh) };
  // A claim record whose state cannot be established may be a refresh that was killed between spawning
  // its install and recording it. A directory that could not be read is the storage failure already
  // being degraded on, not a claim.
  const unresolved = survey.unresolved.find((problem) => problem.path.endsWith('.claim'));
  if (unresolved) return { kind: 'unresolved', path: unresolved.path, reason: unresolved.reason };
  return null;
}

export function warmClaimBlockedLine(reason: string, blocker: WarmClaimBlocker): string {
  const what =
    blocker.kind === 'refresh'
      ? `${warmCommand(blocker.holder.phase)} (pid ${blocker.holder.pid}) holds this repository`
      : `a claim at ${blocker.path} cannot be resolved: ${blocker.reason}`;
  return phaseLine('lock', `unavailable (${reason}); ${what}`);
}

export function warmClaimBlockedRefusal(blocker: WarmClaimBlocker): string {
  if (blocker.kind === 'refresh') {
    return (
      'Refusing to copy from a main checkout a refresh is rewriting, even without a claim of its own. ' +
      'Wait for that refresh to finish, then run warm again.'
    );
  }
  return (
    'Refusing to copy past a claim Stim cannot resolve. If nothing is warming, remove it and run warm ' +
    `again:\n  ${claimRemoveCommand(blocker.path)}`
  );
}

function installerWaitingLine(pid: number, elapsedMs: number): string {
  return phaseLine(
    'lock',
    `waiting on the install this refresh spawned (pid ${pid}, ${formatElapsed(elapsedMs)} elapsed)`,
  );
}

function installerUnrecordedLine(reason: string): string {
  return phaseLine(
    'lock',
    `could not record the install this refresh spawned (${reason}); holding the claim here until it exits`,
  );
}

interface InstallerHold extends InstallerClaim {
  /** Whether a writer this refresh spawned may still be alive, in which case the claim must not be released. */
  holding: () => boolean;
}

function installerClaim(
  claim: ClaimHandle,
  { now, progressMs, out }: { now: () => number; progressMs: number; out: (line: string) => void },
): InstallerHold {
  // Every group this claim has spawned and not yet watched die. The claim file records only the most
  // recent one, so a crash is covered for that group; the list covers all of them for this process.
  let groups: number[] = [];

  const forget = (): void => {
    groups = [];
    try {
      clearClaimChild(claim);
    } catch {
      // The claim store stopped accepting writes; releasing it will fail the same way and leave the
      // pending record, which reads as unresolvable rather than as free.
    }
  };

  const alive = (): number | null => groups.find((pid) => processGroupAlive(pid)) ?? null;

  return {
    declare: () => markClaimChildPending(claim),
    record: (pid) => {
      // Node leaves pid undefined when the spawn itself failed, so there is no group and nothing to hold.
      if (pid === null) {
        forget();
        return;
      }
      groups.push(pid);
      const captured = captureProcessIdentity(pid);
      let failure = captured.ok ? null : captured.reason;
      if (captured.ok) {
        try {
          setClaimChild(claim, { pid, processToken: captured.token });
          return;
        } catch (error) {
          failure = (error as Error)?.message ?? String(error);
        }
      }
      // The record is the only thing that outlives this process, so without it the claim can only be
      // held from here: never released while the group is alive, and never released at all if this
      // process cannot establish that it is gone.
      if (!processGroupAlive(pid)) {
        forget();
        return;
      }
      out(installerUnrecordedLine(String(failure)));
    },
    settle: async () => {
      const started = now();
      let lastProgress = started;
      for (;;) {
        const pid = alive();
        if (pid === null) {
          forget();
          return { settled: true, pid: null, waitedMs: now() - started };
        }
        const elapsed = now() - started;
        if (elapsed >= INSTALLER_CEILING_MS) return { settled: false, pid, waitedMs: elapsed };
        if (now() - lastProgress >= progressMs) {
          lastProgress = now();
          out(installerWaitingLine(pid, elapsed));
        }
        await defaultSleep(INSTALLER_POLL_MS);
      }
    },
    holding: () => alive() !== null,
  };
}

function timeoutError(holder: WarmClaimHolder | null, elapsedMs: number, root: string): Error {
  const who = holder ? `${warmCommand(holder.phase)} (pid ${holder.pid})` : 'another stim worktree warm';
  const error = new Error(
    `Waited ${formatElapsed(elapsedMs)} for ${who} to release the warm lock on this repository. ` +
      `The lock is ${root}; remove it if nothing is really warming:\n  ${claimRemoveCommand(root)}`,
  ) as Error & { code?: string };
  error.code = 'STIM_LOCK_TIMEOUT';
  return error;
}

export async function acquireWarmClaim({
  repositoryRoot,
  phase,
  now = Date.now,
  sleep = defaultSleep,
  pollMs = WARM_CLAIM_POLL_MS,
  progressMs = WARM_CLAIM_PROGRESS_MS,
  ceilingMs = WARM_CLAIM_CEILING_MS,
  out = () => {},
}: WarmClaimOptions): Promise<WarmClaimHold & { release: () => void }> {
  const root = warmClaimPath(repositoryRoot);
  const started = now();
  let lastProgress = started;
  let waitedOn: WarmClaimHolder | null = null;
  let pending: ClaimHandle | null = null;

  try {
    for (;;) {
      const attempt: ClaimAttempt = pending
        ? settleClaim(pending)
        : tryAcquireClaim({
            root,
            mode: phase === 'refresh' ? 'exclusive' : 'shared',
            label: WARM_CLAIM_LABEL,
          });
      const acquired = attempt.acquired;
      if (acquired) {
        const installer = installerClaim(acquired, { now, progressMs, out });
        return {
          wait: { waitedMs: now() - started, holder: waitedOn },
          installer,
          // Releasing a claim a spawned writer is still covered by is the one outcome that must be
          // impossible, so the claim outlives this process instead: its child record keeps it held.
          release: () => {
            if (installer.holding()) return;
            releaseClaim(acquired);
          },
        };
      }
      // A writer keeps the slot it published while live readers drain, so new readers wait on it.
      pending = attempt.pending ?? null;
      const holder = attempt.held ?? attempt.waitingFor?.[0];
      if (holder) waitedOn = asHolder(holder);

      const elapsed = now() - started;
      if (elapsed >= ceilingMs) throw timeoutError(waitedOn, elapsed, root);
      if (waitedOn && now() - lastProgress >= progressMs) {
        lastProgress = now();
        out(waitingLine(waitedOn, elapsed));
      }
      await sleep(pollMs);
    }
  } catch (error) {
    releaseClaim(pending);
    throw error;
  }
}

export async function withWarmClaim<T>(
  options: WarmClaimOptions,
  fn: (hold: WarmClaimHold) => Promise<T> | T,
): Promise<T> {
  const { release, ...hold } = await acquireWarmClaim(options);
  try {
    return await fn(hold);
  } finally {
    release();
  }
}
