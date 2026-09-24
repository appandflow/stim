import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isClaimRefusal, isClaimUnavailable, readClaimSet } from '../ownership-claim.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { managedLockHolders } from '../engine/tunnel.ts';
import {
  withWorkspaceProcessLock,
  workspaceProcessLockError,
  workspaceProcessLockPath,
} from '../engine/workspace-process-lock.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { getProject } from './config.ts';
import { workspaceDir } from './paths.ts';
import { readWorkspaceState } from './workspace-state.ts';

const NATIVE_RUN = 'native-run';
const NATIVE_RUN_HELD = 'a stim ios or android run holds its native-run.lock';

interface InUseChecks {
  supervisor?: boolean;
  managedLocks?: boolean;
}

export function workspaceInUse(
  root: string,
  { supervisor = true, managedLocks = true, nativeRun = true }: InUseChecks & { nativeRun?: boolean } = {},
): string[] {
  const reasons: string[] = [];
  if (supervisor) {
    const project = getProject(root);
    const target = resolveSupervisorTarget({
      state: readWorkspaceState(root)?.supervisor,
      record: project?.supervisor,
      reservedPort: project?.metroPort,
    });
    if (target.status === 'ours') reasons.push(`its dev server supervisor (pid ${target.pid}) is running`);
    else if (target.status === 'unverified') {
      reasons.push(`its dev server supervisor cannot be verified: ${target.reason ?? 'unknown identity'}`);
    }
  }
  if (nativeRun) {
    const claims = readClaimSet(workspaceProcessLockPath(workspaceDir(root), NATIVE_RUN, true));
    if (claims.live.length) reasons.push(NATIVE_RUN_HELD);
    else if (claims.unresolved[0])
      reasons.push(`its native-run.lock cannot be resolved: ${claims.unresolved[0].reason}`);
  }
  const self = canonicalPath(root);
  for (const [kind, entries] of [
    ['build lock', listBuildLocks()],
    ['build slot', listBuildSlots()],
  ] as const) {
    for (const entry of entries) {
      if (!entry.alive && !entry.unresolved) continue;
      if (entry.projectRoot !== null && canonicalPath(entry.projectRoot) === self) {
        reasons.push(`a ${entry.alive ? 'live' : 'unresolvable'} ${kind} at ${entry.path} names it`);
      }
    }
  }
  if (managedLocks) reasons.push(...managedLockHolders(root));
  return reasons;
}

export function emptyWorkspaceDir(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name !== `${NATIVE_RUN}.lock`) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

export type IdleWorkspaceRun<T> = { ran: true; value: T } | { ran: false; reasons: string[] };

export async function withIdleWorkspace<T>(
  root: string,
  fn: () => T | Promise<T>,
  { purpose, ...checks }: InUseChecks & { purpose: string },
): Promise<IdleWorkspaceRun<T>> {
  try {
    return await withWorkspaceProcessLock(
      workspaceDir(root),
      NATIVE_RUN,
      async (): Promise<IdleWorkspaceRun<T>> => {
        const reasons = workspaceInUse(root, { ...checks, nativeRun: false });
        if (reasons.length) return { ran: false, reasons };
        return { ran: true, value: await fn() };
      },
      { external: true, waitMs: 0, ownerPurpose: purpose },
    );
  } catch (error) {
    if (workspaceProcessLockError(error)) return { ran: false, reasons: [NATIVE_RUN_HELD] };
    if (isClaimRefusal(error) || isClaimUnavailable(error)) {
      return { ran: false, reasons: [`its native-run.lock cannot be taken: ${error.reason}`] };
    }
    throw error;
  } finally {
    try {
      rmdirSync(workspaceDir(root));
    } catch {}
  }
}
