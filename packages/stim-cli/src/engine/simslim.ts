import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';
import {
  ClaimRefusedError,
  claimRemoveCommand,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
} from '../ownership-claim.ts';
import { getExecutor } from '../exec.ts';
import { createLineReader, stripAnsi, waitForChild, type ChildResult } from '../process-output.ts';

type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface SimSlimResult {
  managed: boolean;
  profile: string | null;
}

export async function reconcileSimSlim({
  udid,
  profile,
  previouslyManaged = false,
  out = () => {},
  spawn,
  timeoutMs = 12 * 60 * 1000,
  cleanupMs = 10000,
}: {
  udid: string;
  profile?: string | null;
  previouslyManaged?: boolean;
  out?: (line: string) => void;
  spawn?: SpawnFn;
  timeoutMs?: number;
  cleanupMs?: number;
}): Promise<SimSlimResult> {
  if (!profile && !previouslyManaged) return { managed: false, profile: null };

  const action = profile ? 'on' : 'off';
  const args = profile ? ['on', udid, '--profile', profile] : ['off', udid];
  const lines: string[] = [];
  const onLine = (raw: string) => {
    const line = stripAnsi(raw).trim();
    if (!line) return;
    lines.push(line);
    if (lines.length > 20) lines.shift();
    out(`SimSlim: ${line}`);
  };
  const stdout = createLineReader(onLine);
  const stderr = createLineReader(onLine);

  const root = join(getConfigDir(), 'simslim-locks', `${encodeURIComponent(udid.toLowerCase())}.lock`);
  const label = `SimSlim for ${udid}`;
  const attempt = tryAcquireClaim({ root, mode: 'exclusive', label });
  if (attempt.pending) releaseClaim(attempt.pending);
  const claim = attempt.acquired;
  if (!claim) {
    throw new ClaimRefusedError({
      root,
      claimPath: attempt.held?.path ?? root,
      label,
      reason: 'another SimSlim operation is still using this simulator',
    });
  }

  let child: ChildProcess | undefined;
  let result: ChildResult | undefined;
  let identity: ProcessRecord | undefined;
  let cancellation: 'SIGINT' | 'SIGTERM' | undefined;
  const stopGroup = () => {
    if (child?.pid !== undefined && identity && inspectProcessIdentity(identity) === 'same') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  };
  const cancel = (signal: 'SIGINT' | 'SIGTERM') => {
    cancellation ??= signal;
    stopGroup();
  };
  const onInterrupt = () => cancel('SIGINT');
  const onTerminate = () => cancel('SIGTERM');
  const groupAlive = () => child?.pid !== undefined && processGroupAlive(child.pid);
  const settled = () => result !== undefined && !groupAlive();
  const waitUntil = async (deadline: number, cancellable = false) => {
    while (!settled() && Date.now() < deadline) {
      if (cancellable && cancellation) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
    return settled();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('exit', stopGroup);
  try {
    markClaimChildPending(claim);
    try {
      child = (spawn ?? ((cmd, childArgs, opts) => getExecutor().spawn(cmd, childArgs, opts)))('simslim', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      throw simslimLaunchError(error);
    }
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    void waitForChild(child).then((value) => {
      result = value;
      return undefined;
    });
    if (child.pid !== undefined) {
      const captured = captureProcessIdentity(child.pid);
      if (captured.ok) {
        identity = { pid: child.pid, processToken: captured.token };
        try {
          setClaimChild(claim, identity);
        } catch {}
      }
    }
    const completed = await waitUntil(Date.now() + timeoutMs, true);
    if (cancellation || !completed) {
      stopGroup();
      const stopped = await waitUntil(Date.now() + cleanupMs);
      const detail = lines.length ? ` ${lines.join(' | ')}` : '';
      const recovery = stopped
        ? 'Its process group has stopped. Retry stim ios to reconcile the retained simulator settings.'
        : `Its process group could not be confirmed stopped. The claim remains at ${claim.path}. ` +
          `Inspect the SimSlim process group ${child.pid ?? 'unknown'} before retrying. ` +
          `Only when nothing is using it, remove the claim: ${claimRemoveCommand(claim.path)}`;
      const reason = cancellation ? `interrupted by ${cancellation}` : `exceeded ${Math.round(timeoutMs / 1000)}s`;
      const message = `SimSlim ${action} ${reason}. ${recovery}${detail}`;
      if (cancellation) out(message);
      throw Object.assign(new Error(message), { code: cancellation ? 'EINTR' : 'ETIMEDOUT' });
    }
  } finally {
    if (!child || settled()) releaseClaim(claim);
    else {
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref();
    }
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('exit', stopGroup);
    if (cancellation) process.exit(cancellation === 'SIGINT' ? 130 : 143);
  }

  stdout.flush();
  stderr.flush();

  if (result?.error) throw simslimLaunchError(result.error);
  if (result?.code !== 0) {
    const detail = lines.length ? ` ${lines.join(' | ')}` : '';
    throw new Error(`SimSlim ${action} failed with exit code ${result?.code ?? 'unknown'}.${detail}`);
  }
  return { managed: Boolean(profile), profile: profile ?? null };
}

function simslimLaunchError(error: unknown): Error {
  const cause = error as NodeJS.ErrnoException;
  if (cause?.code === 'ENOENT') {
    return new Error(
      'SimSlim is configured but the `simslim` command is not installed. Run `brew install mobai-app/tap/simslim`.',
      { cause },
    );
  }
  return new Error(`Could not start SimSlim: ${String((cause as Error)?.message || cause)}`, { cause });
}

export function simslimIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().runQuiet('command -v simslim', { timeoutMs: 5000 }));
  } catch {
    return false;
  }
}
