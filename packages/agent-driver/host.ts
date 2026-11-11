import { randomUUID } from 'node:crypto';
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
import type { AgentDriverHost, AgentDriverProcess, AgentDriverStopStep } from './driver.ts';

function owner(process: AgentDriverProcess): ClaimOwner {
  return { pid: process.pid, processToken: process.token };
}

function identity(record: ClaimOwner | null | undefined): AgentDriverProcess | null {
  return record ? { pid: record.pid, token: record.processToken } : null;
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

/** The engine side of `AgentDriverHost`, over core's ownership claims and process identities. One per driver. */
export function createAgentDriverHost(): AgentDriverHost {
  const held = new Map<string, ClaimHandle>();
  const handle = (claim: string): ClaimHandle => {
    const found = held.get(claim);
    if (!found) throw new Error(`This host holds no claim ${claim}.`);
    return found;
  };
  return {
    claims: {
      async take(root, label) {
        const attempt = tryAcquireClaim({ root, mode: 'exclusive', label });
        if (attempt.pending) releaseClaim(attempt.pending);
        if (!attempt.acquired)
          return { held: attempt.held?.path ?? null, waitingFor: attempt.waitingFor?.[0]?.path ?? null };
        const claim = randomUUID();
        held.set(claim, attempt.acquired);
        return {
          claim,
          path: attempt.acquired.path,
          previousChild: identity(attempt.reaped.find((holder) => holder.child)?.child),
        };
      },
      async childPending(claim) {
        markClaimChildPending(handle(claim));
      },
      async setChild(claim, child) {
        setClaimChild(handle(claim), owner(child));
      },
      async clearChild(claim) {
        clearClaimChild(handle(claim));
      },
      async release(claim) {
        if (!releaseClaim(handle(claim))) return false;
        held.delete(claim);
        return true;
      },
      async stopStale(root, label, { own, steps }) {
        const mine = own === undefined ? null : handle(own);
        const survey = readClaimSet(root);
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
        const captured = captureProcessIdentity(pid);
        return captured.ok ? { pid, token: captured.token } : null;
      },
      async inspect(process) {
        return inspectProcessIdentity(owner(process));
      },
      async stop(target, { group, steps }) {
        const record = owner(target);
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
      },
    },
  };
}
