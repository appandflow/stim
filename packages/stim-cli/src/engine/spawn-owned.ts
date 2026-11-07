import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { windowsShellLaunchArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimDetails,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';
import { signalProcessTreeAsync } from '../metro.ts';

export interface OwnedLaunch {
  file: string;
  args: readonly string[];
  cwd: string;
  /** The launching caller's own environment, which the process gets as it is. */
  env: NodeJS.ProcessEnv;
  /** The files stdout and stderr go to; one path for both shares the file. Windows starts the process without either. */
  stdout: string;
  stderr: string;
  /** Empties the output files first instead of appending to them. */
  truncate?: boolean;
  /** The exclusive claim the process holds for as long as it runs. */
  claim: { root: string; label: string; details?: ClaimDetails };
  /** The launching operation's claims, which record the process from its spawn on; the caller clears them once it has recorded the process. */
  declare: Iterable<ClaimHandle>;
}

export interface OwnedProcess {
  pid: number;
  processToken: string;
  claim: ClaimHandle;
}

/**
 * Starts a process that outlives its launcher: detached, in its own process group, with file stdio, and holding an
 * exclusive ownership claim of its own, so stop, idle stop and status find it through that claim whether the launcher
 * was a command that exits or a long-lived host. If identity capture or claim publication fails, launching claims are
 * retained for reconciliation until the process and any separately grouped children have been verified stopped.
 */
export async function spawnOwned(launch: OwnedLaunch): Promise<OwnedProcess> {
  const declared = [...launch.declare];
  for (const claim of declared) markClaimChildPending(claim);
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  try {
    if (process.platform === 'win32') pid = startWindows(launch);
    else {
      child = startDetached(launch);
      pid = child.pid;
    }
  } catch (error) {
    if (process.platform === 'win32')
      throw new WorkspaceProcessCleanupError(
        declared,
        `Could not verify whether the ${launch.claim.label} process started.`,
        'Verify that the launched process and its children have stopped before retrying.',
        error instanceof Error ? error : undefined,
      );
    for (const claim of declared) clearClaimChild(claim);
    throw error;
  }
  if (pid === undefined) {
    if (process.platform === 'win32')
      throw new WorkspaceProcessCleanupError(
        declared,
        `Could not verify whether the ${launch.claim.label} process started.`,
        'Verify that the launched process and its children have stopped before retrying.',
      );
    for (const claim of declared) clearClaimChild(claim);
    throw new Error(`Could not start ${launch.file}.`);
  }
  const captured = captureProcessIdentity(pid);
  if (!captured.ok) {
    try {
      child?.kill('SIGKILL');
    } catch {}
    throw new WorkspaceProcessCleanupError(
      declared,
      `Could not verify the ${launch.claim.label} process: ${captured.reason}.`,
      'Verify that the launched process and its children have stopped before retrying.',
    );
  }
  const owner = { pid, processToken: captured.token };
  let claim: ClaimHandle | undefined;
  try {
    // Windows cannot prove that a dead leader's descendants have exited, so keep the pending declaration.
    if (process.platform !== 'win32') for (const declaration of declared) setClaimChild(declaration, owner);
    const attempt = tryAcquireClaim({ ...launch.claim, mode: 'exclusive', owner });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new Error(`The ${launch.claim.label} claim is held at ${attempt.held?.path ?? launch.claim.root}.`);
    claim = attempt.acquired;
    if (process.platform !== 'win32') setClaimChild(claim, owner);
  } catch (error) {
    try {
      for (const declaration of declared) markClaimChildPending(declaration);
    } catch (failure) {
      throw new WorkspaceProcessCleanupError(
        declared,
        `Could not retain the failed ${launch.claim.label} launch declaration.`,
        'Verify that the launched process and its children have stopped before retrying.',
        failure instanceof Error ? failure : undefined,
      );
    }
    if (!(await stopOwnedProcess(owner)))
      throw new WorkspaceProcessCleanupError(
        declared,
        `Could not stop the failed ${launch.claim.label} launch.`,
        'Verify that the launched process and its children have stopped before retrying.',
        error instanceof Error ? error : undefined,
      );
    releaseClaim(claim);
    throw new WorkspaceProcessCleanupError(
      declared,
      `Could not verify that all children of the failed ${launch.claim.label} launch stopped.`,
      'Verify that the launched process and its children have stopped before retrying.',
      error instanceof Error ? error : undefined,
    );
  }
  return { ...owner, claim };
}

export async function stopOwnedProcess(owner: { pid: number; processToken: string }): Promise<boolean> {
  const identity = inspectProcessIdentity(owner);
  if (identity === 'unknown') return false;
  if (process.platform === 'win32') {
    if (identity !== 'same') return false;
    try {
      if (!(await signalProcessTreeAsync(owner.pid, 'SIGKILL', { group: true }))) return false;
    } catch {
      return false;
    }
    return waitForProcessExit(owner, 5000);
  }
  if (identity === 'same') {
    try {
      process.kill(-owner.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) return false;
    }
    if (!(await waitForProcessExit(owner, 5000))) return false;
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      process.kill(-owner.pid, 0);
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ESRCH';
    }
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
}

function startDetached(launch: OwnedLaunch): ChildProcess {
  for (const file of new Set([launch.stdout, launch.stderr])) {
    mkdirSync(dirname(file), { recursive: true });
    if (launch.truncate) writeFileSync(file, '');
  }
  const out = openSync(launch.stdout, 'a');
  let err = out;
  try {
    if (launch.stderr !== launch.stdout) err = openSync(launch.stderr, 'a');
    const child = getExecutor().spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ['ignore', out, err],
    });
    child.once('error', () => {});
    child.unref?.();
    return child;
  } finally {
    closeSync(out);
    if (err !== out) closeSync(err);
  }
}

// libuv/libuv#1490: a detached child spawned by Node on win32 inherits every inheritable handle of this process.
function startWindows(launch: OwnedLaunch): number | undefined {
  const launcher = windowsShellLaunchArgs(launch);
  const pid = Number(
    getExecutor().runFile(launcher.file, launcher.args, {
      cwd: launch.cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        ...launcher.env,
      },
      timeoutMs: 30_000,
    }),
  );
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
