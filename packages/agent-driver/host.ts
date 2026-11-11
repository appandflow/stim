import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  claimRemoveCommand,
  clearClaimChild,
  markClaimChildPending,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimOwner,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import type { AgentDriverHost, AgentDriverInput, AgentDriverProcess, AgentDriverStopStep } from './driver.ts';

const DISPOSE_STOP: AgentDriverStopStep[] = [
  ['SIGTERM', 3000],
  ['SIGKILL', 2000],
];

/** The engine's `AgentDriverHost` for one driver, and `dispose` for when that driver goes away. */
export interface AgentDriverHostHandle extends AgentDriverHost {
  /**
   * Stops the child recorded on each claim the driver still holds and releases the claim. A claim whose child
   * cannot be stopped or identified is kept; the result names each kept claim and the command that removes it.
   */
  dispose(): Promise<string[]>;
}

interface Held {
  handle: ClaimHandle;
  label: string;
  child: ClaimOwner | null;
  pending: boolean;
}

function key(process: AgentDriverProcess): string {
  return `${process.pid}:${process.token}`;
}

function owner(process: AgentDriverProcess): ClaimOwner {
  return { pid: process.pid, processToken: process.token };
}

function identity(record: ClaimOwner | null | undefined): AgentDriverProcess | null {
  return record ? { pid: record.pid, token: record.processToken } : null;
}

/** `path` with its longest existing ancestor resolved through symlinks. */
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function stopChild(record: ClaimOwner, steps: AgentDriverStopStep[]): Promise<boolean> {
  for (const [signal, waitMs] of steps) {
    const status = inspectProcessIdentity(record);
    if (status === 'gone' || status === 'different') return true;
    if (status === 'unknown') return false;
    try {
      process.kill(record.pid, signal);
    } catch {}
    if (await waitForProcessExit(record, waitMs)) return true;
  }
  return false;
}

async function stopProcess(record: ClaimOwner, group: boolean, steps: AgentDriverStopStep[]): Promise<boolean> {
  for (const [signal, waitMs] of steps) {
    const status = inspectProcessIdentity(record);
    if (status === 'gone' || status === 'different') return true;
    if (status === 'same') {
      try {
        process.kill(group ? -record.pid : record.pid, signal);
      } catch {}
    }
    if (await waitForProcessExit(record, waitMs)) return true;
  }
  return false;
}

/**
 * The engine side of `AgentDriverHost` for the driver `input` describes. Claims are taken only at `claimRoot` or
 * under `stateDir`, and only processes this host captured, or found recorded on a claim it took, can be inspected,
 * signalled or recorded as a claim's child.
 */
export function createAgentDriverHost({
  stateDir,
  claimRoot,
}: Pick<AgentDriverInput, 'stateDir' | 'claimRoot'>): AgentDriverHostHandle {
  const held = new Map<string, Held>();
  const issued = new Set<string>();
  let disposed = false;
  const issue = (process: AgentDriverProcess | null) => {
    if (process) issued.add(key(process));
    return process;
  };
  const captured = (process: AgentDriverProcess): ClaimOwner => {
    if (!issued.has(key(process))) throw new Error(`This host did not capture process ${process.pid}.`);
    return owner(process);
  };
  const scoped = (root: string): string => {
    const path = canonical(root);
    if (path !== canonical(claimRoot) && !inside(path, canonical(stateDir)))
      throw new Error(`The claim root ${root} is outside this driver's state.`);
    return root;
  };
  const claimOf = (claim: string): Held => {
    const found = held.get(claim);
    if (!found) throw new Error(`This host holds no claim ${claim}.`);
    return found;
  };
  return {
    claims: {
      async take(root, label) {
        if (disposed) throw new Error('This driver host is closed.');
        const attempt = tryAcquireClaim({ root: scoped(root), mode: 'exclusive', label });
        if (attempt.pending) releaseClaim(attempt.pending);
        if (!attempt.acquired)
          return { held: attempt.held?.path ?? null, waitingFor: attempt.waitingFor?.[0]?.path ?? null };
        const claim = randomUUID();
        held.set(claim, { handle: attempt.acquired, label, child: null, pending: false });
        return {
          claim,
          path: attempt.acquired.path,
          previousChild: issue(identity(attempt.reaped.find((holder) => holder.child)?.child)),
        };
      },
      async childPending(claim) {
        const found = claimOf(claim);
        markClaimChildPending(found.handle);
        found.pending = true;
      },
      async setChild(claim, child) {
        const found = claimOf(claim);
        const record = captured(child);
        setClaimChild(found.handle, record);
        found.child = record;
      },
      async clearChild(claim) {
        const found = claimOf(claim);
        clearClaimChild(found.handle);
        found.child = null;
        found.pending = false;
      },
      async release(claim) {
        if (!releaseClaim(claimOf(claim).handle)) return false;
        held.delete(claim);
        return true;
      },
      async stopStale(root, label, { own, steps }) {
        const mine = own === undefined ? null : claimOf(own).handle;
        const survey = readClaimSet(scoped(root));
        const kept = survey.unresolved.map((problem) => problem.path);
        let reap = survey.dead.length > 0;
        for (const holder of survey.live) {
          const isMine = holder.claimId === mine?.claimId;
          if (!isMine) {
            const status = inspectProcessIdentity(holder.owner);
            if (status === 'unknown') kept.push(holder.path);
            if (status === 'same' || status === 'unknown') continue;
          }
          if (holder.childDeclared && !(holder.child && (await stopChild(holder.child, steps)))) {
            kept.push(holder.path);
            continue;
          }
          if (isMine) releaseClaim(mine);
          else reap = true;
        }
        const [unresolved] = kept;
        if (unresolved !== undefined)
          throw new Error(
            `The ${label} is unresolved; its claim ${unresolved} was kept. Once it is gone, clear it with: ${claimRemoveCommand(unresolved)}`,
          );
        if (own !== undefined) held.delete(own);
        if (!reap) return;
        const attempt = tryAcquireClaim({ root, mode: 'exclusive', label });
        releaseClaim(attempt.acquired ?? attempt.pending);
      },
      async removeCommand(path) {
        return claimRemoveCommand(path);
      },
    },
    processes: {
      async capture(pid) {
        const result = captureProcessIdentity(pid);
        return result.ok ? issue({ pid, token: result.token }) : null;
      },
      async inspect(process) {
        return inspectProcessIdentity(captured(process));
      },
      async stop(target, { group, steps }) {
        return stopProcess(captured(target), group, steps);
      },
    },
    async dispose() {
      disposed = true;
      const kept: string[] = [];
      for (const [claim, found] of held) {
        const { path } = found.handle;
        const stopped = found.child ? await stopProcess(found.child, false, DISPOSE_STOP) : !found.pending;
        if (!stopped || !releaseClaim(found.handle)) {
          kept.push(
            `The ${found.label} is unresolved; its claim ${path} was kept. Once it is gone, clear it with: ${claimRemoveCommand(path)}`,
          );
          continue;
        }
        held.delete(claim);
      }
      return kept;
    },
  };
}
