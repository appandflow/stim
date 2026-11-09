import { realpathSync } from 'node:fs';
import { fingerprint } from './evaluate.ts';
import { readWorkspaceEnv } from './index-store.ts';
import { isUncertain } from './key.ts';
import type { VerifyRequest } from './verify.ts';

/** Workspaces whose fingerprint one pass brings up to date. */
const MAX_PRECOMPUTES_PER_PASS = 2;

export type PrecomputeOutcome =
  | { root: string; outcome: 'computed'; hash: string; from: 'evaluated' | 'index' }
  | { root: string; outcome: 'skipped'; reason: string };

/**
 * One background pass, as the daemon and later the passes worker run it: brings the index of up to two workspaces up
 * to date under the env each last computed its fingerprint with, re-running only the parts whose reads changed.
 * `admitted` is the caller's admission decision for the precomputes.
 */
export async function precomputePass(
  requests: readonly VerifyRequest[],
  { admitted, signal }: { admitted: boolean; signal: AbortSignal },
): Promise<{ precomputed: PrecomputeOutcome[] }> {
  const precomputed: PrecomputeOutcome[] = [];
  for (const request of admitted ? requests.slice(0, MAX_PRECOMPUTES_PER_PASS) : []) {
    let project: string;
    try {
      project = realpathSync.native(request.root);
    } catch {
      precomputed.push({ root: request.root, outcome: 'skipped', reason: 'the workspace is gone' });
      continue;
    }
    const recorded = readWorkspaceEnv(project);
    if (!recorded) {
      precomputed.push({ root: request.root, outcome: 'skipped', reason: 'no fingerprint env recorded yet' });
      continue;
    }
    const result = await fingerprint(project, request.target, {
      env: recorded.env,
      embedMode: request.embedMode,
      signal,
    });
    precomputed.push(
      isUncertain(result)
        ? { root: request.root, outcome: 'skipped', reason: result.uncertain }
        : { root: request.root, outcome: 'computed', hash: result.hash, from: result.from },
    );
  }
  return { precomputed };
}
