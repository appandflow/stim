import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { workspaceDir } from '../../workspace/paths.ts';
import {
  claimRemoveCommand,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { signalProcessTree } from '../../metro.ts';

const claimPath = (root: string, streamId: string) =>
  join(workspaceDir(root), 'log-streams', `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`);
const historyPath = (root: string, streamId: string) =>
  join(workspaceDir(root), 'log-backfills', `${createHash('sha256').update(streamId).digest('hex')}.claim`);

async function recover(path: string, expected?: string): Promise<void> {
  const survey = readClaimSet(path);
  if (survey.unresolved.length)
    throw new Error(
      `Device log ownership at ${path} is unresolved; inspect it before running ${claimRemoveCommand(path)}.`,
    );
  if (expected && ![...survey.live, ...survey.dead].some((holder) => holder.details.streamId === expected))
    throw new Error(
      `The device log stream ${expected} has no verifiable claim at ${path}; inspect it before removing its record.`,
    );
  for (const holder of survey.dead) {
    if (expected && holder.details.streamId !== expected) throw new Error(`The device log stream at ${path} changed.`);
    if (!releaseClaim({ ...holder, root: path, label: 'device log stream' }))
      throw new Error(`The device log claim at ${path} changed while it was being recovered.`);
  }
  for (const holder of survey.live) {
    if (expected && holder.details.streamId !== expected) throw new Error(`The device log stream at ${path} changed.`);
    const owner = inspectProcessIdentity(holder.owner);
    if (owner === 'same' || owner === 'unknown' || !holder.child)
      throw new Error(`Another device log stream holds ${path}; stop that stream before replacing it.`);
    const child = holder.child;
    if (inspectProcessIdentity(child) !== 'same')
      throw new Error(
        `The device log child at ${path} cannot be verified; inspect it before running ${claimRemoveCommand(path)}.`,
      );
    try {
      signalProcessTree(child.pid, 'SIGTERM', { group: process.platform !== 'win32' });
    } catch {}
    const alive = () =>
      process.platform === 'win32' ? inspectProcessIdentity(child) === 'same' : processGroupAlive(child.pid);
    for (const deadline = Date.now() + 2000; alive() && Date.now() < deadline;)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (alive()) throw new Error(`The device log child at ${path} did not stop; inspect it before retrying.`);
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

export async function clearStreamClaim(root: string, streamId: string): Promise<void> {
  await clearHistoryClaim(root, streamId);
  await recover(claimPath(root, streamId), streamId);
}

export async function takeStreamClaim(root: string, streamId: string): Promise<ClaimHandle> {
  const path = claimPath(root, streamId);
  await recover(path);
  const attempt = tryAcquireClaim({ root: path, mode: 'exclusive', label: 'device log stream', details: { streamId } });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    throw new Error(`Another device log stream holds ${path}; stop that stream before replacing it.`);
  return attempt.acquired;
}
