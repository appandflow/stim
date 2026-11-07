import { closeSync, mkdirSync, openSync } from 'node:fs';
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
import { captureProcessIdentity } from '../process-identity.ts';

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
  /** The launching operation's claims, which record the process from its spawn until its own claim exists. */
  declare?: Iterable<ClaimHandle>;
}

export interface OwnedProcess {
  pid: number;
  processToken: string;
  claim: ClaimHandle;
}

/**
 * Starts a process that outlives its launcher: detached, in its own process group, with file stdio, and holding an
 * exclusive ownership claim of its own, so stop, idle stop and status find it through that claim whether the launcher
 * was a command that exits or a long-lived host. A process whose identity cannot be captured, or whose claim is held,
 * is killed before this throws.
 */
export function spawnOwned(launch: OwnedLaunch): OwnedProcess {
  const declared = [...(launch.declare ?? [])];
  for (const claim of declared) markClaimChildPending(claim);
  let pid: number | undefined;
  try {
    pid = process.platform === 'win32' ? startWindows(launch) : startDetached(launch);
  } catch (error) {
    for (const claim of declared) clearClaimChild(claim);
    throw error;
  }
  const kill = () => {
    try {
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
    } catch {}
  };
  if (pid === undefined) {
    for (const claim of declared) clearClaimChild(claim);
    throw new Error(`Could not start ${launch.file}.`);
  }
  const captured = captureProcessIdentity(pid);
  if (!captured.ok) {
    kill();
    for (const claim of declared) clearClaimChild(claim);
    throw Object.assign(
      new Error(`Could not verify the ${launch.claim.label} process: ${captured.reason}; it was stopped.`),
      {
        code: 'STIM_CLAIM_UNAVAILABLE',
        remedy: 'Check that this user can inspect its own processes (ps), then run the command again.',
      },
    );
  }
  const owner = { pid, processToken: captured.token };
  for (const claim of declared) setClaimChild(claim, owner);
  let claim: ClaimHandle | undefined;
  try {
    const attempt = tryAcquireClaim({ ...launch.claim, mode: 'exclusive', owner });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new Error(`The ${launch.claim.label} claim is held at ${attempt.held?.path ?? launch.claim.root}.`);
    claim = attempt.acquired;
  } catch (error) {
    kill();
    releaseClaim(claim);
    throw error;
  }
  for (const each of declared) clearClaimChild(each);
  return { ...owner, claim };
}

function startDetached(launch: OwnedLaunch): number | undefined {
  const flags = launch.truncate ? 'w' : 'a';
  for (const file of [launch.stdout, launch.stderr]) mkdirSync(dirname(file), { recursive: true });
  const out = openSync(launch.stdout, flags);
  const err = launch.stderr === launch.stdout ? out : openSync(launch.stderr, flags);
  try {
    const child = getExecutor().spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ['ignore', out, err],
    });
    child.once('error', () => {});
    child.unref?.();
    return child.pid;
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
