import { join } from 'node:path';
import {
  READY_PHASE_MS,
  WARM_KEY,
  readWarmRecord,
  type EnvironmentState,
  type WarmRecord,
  type WarmStep,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { readClaimSet, releaseClaim, tryAcquireClaim, type ClaimHandle, type ClaimSurvey } from '../ownership-claim.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { updateWorkspaceState } from '../workspace/workspace-state.ts';

export interface WarmProgress {
  step(step: WarmStep): void;
  finish(succeeded: boolean): void;
}

const NO_WARM_PROGRESS: WarmProgress = { step: () => {}, finish: () => {} };

function warmProgressClaimRoot(root: string): string {
  return join(workspaceDir(root), 'warm.lock');
}

/**
 * Records that `stim worktree warm` runs in the workspace at `root`, under an ownership claim this process holds
 * until `finish`, so a warm that was killed reads as over. A process that cannot take the claim records nothing.
 */
export function startWarmProgress(
  root: string,
  step: WarmStep,
  { note, now = Date.now }: { note: (line: string) => void; now?: () => number },
): WarmProgress {
  let claim: ClaimHandle;
  try {
    ensureWorkspaceStorage(root);
    const attempt = tryAcquireClaim({ root: warmProgressClaimRoot(root), mode: 'shared', label: 'worktree warm' });
    if (!attempt.acquired) throw new Error('another process holds its claim exclusively');
    claim = attempt.acquired;
  } catch (error) {
    note(`Warm progress is not recorded for status: ${(error as Error)?.message || error}`);
    return NO_WARM_PROGRESS;
  }
  const startedAt = new Date(now()).toISOString();
  const ours = (state: WorkspaceState): boolean => {
    const record = readWarmRecord(state);
    return record?.phase === 'warming' && record.claim.claimId === claim.claimId;
  };
  let warned = false;
  const write = (update: (state: WorkspaceState) => WorkspaceState): void => {
    try {
      updateWorkspaceState(root, update);
    } catch (error) {
      if (warned) return;
      warned = true;
      note(`Warm progress could not be recorded in the workspace state: ${(error as Error)?.message || error}`);
    }
  };
  const warming = (current: WarmStep): WarmRecord => ({
    phase: 'warming',
    step: current,
    startedAt,
    claim: { root: claim.root, claimId: claim.claimId },
  });
  write((state) => ({ ...state, [WARM_KEY]: warming(step) }));
  return {
    step(next) {
      write((state) => (ours(state) ? { ...state, [WARM_KEY]: warming(next) } : state));
    },
    finish(succeeded) {
      write((state) => {
        if (!ours(state)) return state;
        const { [WARM_KEY]: _, ...rest } = state;
        return succeeded ? { ...rest, [WARM_KEY]: { phase: 'ready', at: new Date(now()).toISOString() } } : rest;
      });
      releaseClaim(claim);
    },
  };
}

type PhaseFacts = Pick<EnvironmentState, 'phase' | 'phaseSince' | 'warmStep'>;

/**
 * The lifecycle phase status reports. A warming record counts only while a warm holds the workspace's claim, and a ready
 * record only until the workspace is next used or `READY_PHASE_MS` passes.
 */
export function workspacePhase(
  live: boolean,
  state: WorkspaceState | null,
  { now = Date.now(), survey = readClaimSet }: { now?: number; survey?: (root: string) => ClaimSurvey } = {},
): PhaseFacts {
  if (live) return { phase: 'live', phaseSince: null };
  const record = readWarmRecord(state);
  if (record?.phase === 'warming') {
    if (survey(record.claim.root).live.length) {
      return { phase: 'warming', phaseSince: record.startedAt, warmStep: record.step };
    }
  }
  if (record?.phase === 'ready') {
    const at = Date.parse(record.at);
    const used = Date.parse(String(state?.lastUsedAt ?? ''));
    if (now - at < READY_PHASE_MS && !(used > at)) return { phase: 'ready', phaseSince: record.at };
  }
  return { phase: 'idle', phaseSince: null };
}
