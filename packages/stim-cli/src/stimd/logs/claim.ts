import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { workspaceDir } from '../../workspace/paths.ts';
import {
  claimRemoveCommand,
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { signalProcessTree } from '../../metro.ts';
import { getExecutor } from '../../exec.ts';

export const pendingChildRemoveCommand = (holder: string): string =>
  claimRemoveCommand(`${holder.slice(0, -'.claim'.length)}.child`);

const pendingRemedy = (holder: string): string =>
  `Verify the prior daemon, child and descendants have stopped, then run ${pendingChildRemoveCommand(holder)} and retry`;

export const claimPath = (root: string, streamId: string): string =>
  join(workspaceDir(root), 'log-streams', `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`);
/** Where a physical iPhone console's helper records how the console ended, just before it exits. */
export const consoleExitFile = (root: string, streamId: string): string =>
  join(workspaceDir(root), 'log-streams', `console-${createHash('sha256').update(streamId).digest('hex')}.exit.json`);
const historyPath = (root: string, streamId: string) =>
  join(workspaceDir(root), 'log-backfills', `${createHash('sha256').update(streamId).digest('hex')}.claim`);

async function recover(path: string, expected?: string, beforeRelease?: () => void, handedOver = false): Promise<void> {
  const survey = readClaimSet(path);
  if (survey.unresolved.length) {
    const issue = survey.unresolved[0];
    const remedy = issue?.pendingChild ? pendingRemedy(issue.path) : `Inspect the ownership at ${path}`;
    throw new Error(`Device log ownership at ${path} is unresolved. ${remedy}.`);
  }
  if (
    expected !== undefined &&
    !(handedOver && !survey.live.length && !survey.dead.length) &&
    ![...survey.live, ...survey.dead].some((holder) => holder.details.streamId === expected)
  )
    throw new Error(
      `The device log stream ${expected} has no verifiable claim at ${path}; inspect it before removing its record.`,
    );
  for (const holder of survey.dead) {
    if (expected !== undefined && holder.details.streamId !== expected)
      throw new Error(`The device log stream at ${path} changed.`);
    if (process.platform === 'win32' && holder.childDeclared) {
      markClaimChildPending({
        ...holder,
        root: path,
        label: 'device log stream',
      });
      throw new Error(`The device log tree at ${path} cannot be verified stopped; ${pendingRemedy(holder.path)}.`);
    }
  }
  for (const holder of survey.live) {
    if (expected !== undefined && holder.details.streamId !== expected)
      throw new Error(`The device log stream at ${path} changed.`);
    const owner = inspectProcessIdentity(holder.owner);
    if (owner === 'same' || owner === 'unknown' || !holder.child)
      throw new Error(`Another device log stream holds ${path}; stop that stream before replacing it.`);
    const child = holder.child;
    if (inspectProcessIdentity(child) !== 'same')
      throw new Error(`The device log child at ${path} cannot be verified; ${pendingRemedy(holder.path)}.`);
    if (process.platform === 'win32') {
      const claim = { ...holder, root: path, label: 'device log stream' };
      markClaimChildPending(claim);
      try {
        await getExecutor().runFileAsync(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        throw new Error(
          `The device log tree at ${path} could not be stopped: ${String(error)}; ${pendingRemedy(holder.path)}.`,
          { cause: error },
        );
      }
      for (const deadline = Date.now() + 2000; inspectProcessIdentity(child) === 'same' && Date.now() < deadline;)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (inspectProcessIdentity(child) !== 'gone')
        throw new Error(`The device log child at ${path} cannot be verified stopped; ${pendingRemedy(holder.path)}.`);
      clearClaimChild(claim);
    } else {
      try {
        signalProcessTree(child.pid, 'SIGTERM', { group: true });
      } catch {}
      for (const deadline = Date.now() + 2000; processGroupAlive(child.pid) && Date.now() < deadline;)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (processGroupAlive(child.pid))
        throw new Error(`The device log child at ${path} did not stop; inspect it before retrying.`);
    }
  }
  beforeRelease?.();
  for (const holder of [...survey.dead, ...survey.live]) {
    if (!releaseClaim({ ...holder, root: path, label: 'device log stream' }))
      throw new Error(`The device log claim at ${path} changed while it was being recovered.`);
  }
}

export async function clearHistoryClaim(root: string, streamId: string): Promise<void> {
  const path = historyPath(root, streamId);
  const survey = readClaimSet(path);
  for (const holder of survey.live) {
    if (holder.details.streamId !== streamId || holder.owner.pid !== process.pid || !holder.child) continue;
    if (inspectProcessIdentity(holder.owner) !== 'same') continue;
    const identity = inspectProcessIdentity(holder.child);
    if (identity === 'same' || identity === 'unknown') continue;
    if (process.platform !== 'win32' && processGroupAlive(holder.child.pid)) continue;
    if (!releaseClaim({ ...holder, root: path, label: 'device log backfill' }))
      throw new Error(`The device log claim at ${path} changed while it was being recovered.`);
  }
  const remaining = readClaimSet(path);
  if (remaining.live.length || remaining.dead.length || remaining.unresolved.length) await recover(path, streamId);
}

export async function takeHistoryClaim(root: string, streamId: string): Promise<ClaimHandle> {
  const path = historyPath(root, streamId);
  await clearHistoryClaim(root, streamId);
  const attempt = tryAcquireClaim({
    root: path,
    mode: 'exclusive',
    label: 'device log backfill',
    details: { streamId },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired) throw new Error(`Another device log backfill holds ${path}.`);
  return attempt.acquired;
}

export async function clearStreamClaim(
  root: string,
  streamId: string,
  beforeRelease: () => void,
  handedOver = false,
): Promise<void> {
  await clearHistoryClaim(root, streamId);
  await recover(claimPath(root, streamId), streamId, beforeRelease, handedOver);
}

export async function takeStreamClaim(root: string, streamId: string): Promise<ClaimHandle> {
  const path = claimPath(root, streamId);
  await recover(path);
  const attempt = tryAcquireClaim({
    root: path,
    mode: 'exclusive',
    label: 'device log stream',
    details: { streamId },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    throw new Error(`Another device log stream holds ${path}; stop that stream before replacing it.`);
  return attempt.acquired;
}

/**
 * Whether the stimd that owned stream `streamId` is provably gone: its claim names the stream, is resolved, and every
 * holder's owner identity reads gone or recycled. A live child it left behind does not change that.
 */
export function streamOwnerGone(root: string, streamId: string): { gone: true } | { gone: false; reason: string } {
  const path = claimPath(root, streamId);
  const survey = readClaimSet(path);
  const issue = survey.unresolved[0];
  if (issue)
    return {
      gone: false,
      reason: `its claim at ${path} is unresolved. ${issue.pendingChild ? pendingRemedy(issue.path) : `Inspect the ownership at ${path}`}`,
    };
  const holders = [...survey.live, ...survey.dead].filter((holder) => holder.details.streamId === streamId);
  if (!holders.length)
    return {
      gone: false,
      reason: `no claim at ${path} names it, so its owner cannot be verified. Once no process writes this stream, \`stim stop\` in the workspace removes its record`,
    };
  for (const holder of holders) {
    const owner = inspectProcessIdentity(holder.owner);
    if (owner === 'same')
      return {
        gone: false,
        reason: `its owner (pid ${holder.owner.pid}) is still running; stop that stimd to replace it`,
      };
    if (owner !== 'gone' && owner !== 'different')
      return {
        gone: false,
        reason: `its owner (pid ${holder.owner.pid}) cannot be identified. Verify that process has stopped, then run ${claimRemoveCommand(holder.path)} and restart stimd`,
      };
  }
  return { gone: true };
}
