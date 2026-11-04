import { setTimeout as delay } from 'node:timers/promises';
import { workspaceNativeRunClaim } from '@stim-cli/core/state';
import {
  isClaimRefusal,
  isClaimUnavailable,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHolder,
} from '@stim-cli/core/ownership-claim';
import type { Refusal, WorkspaceHold } from './share.ts';

const POLL_MS = 50;
/** How long a share start waits for a holder of the workspace's native-run claim; the CLI waits 120 s for the answer. */
export const SHARE_CLAIM_WAIT_MS = 30_000;

function describeHolder({ details, owner }: ClaimHolder): string {
  const { command } = details;
  return typeof command === 'string' ? `\`stim ${command}\` (pid ${owner.pid})` : `another Stim run (pid ${owner.pid})`;
}

/**
 * Takes the workspace's native-run claim, as `stim ios`, `android` and `stop` do, waiting up to `waitMs` for a holder
 * to finish. The claim records `command: 'share'` and no `interrupt`, so `stim stop` waits for it and never signals
 * this process.
 */
export async function holdNativeRun(
  workspace: string,
  { waitMs, stop }: { waitMs: number; stop: () => boolean },
): Promise<WorkspaceHold | Refusal> {
  const path = workspaceNativeRunClaim(workspace);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (stop()) return { code: 'action-failed', message: 'stim-server is stopping.' };
    let attempt;
    try {
      attempt = tryAcquireClaim({
        root: path,
        mode: 'exclusive',
        label: 'native-run lock',
        details: { command: 'share', purpose: 'web share' },
      });
    } catch (cause) {
      return {
        code: 'action-failed',
        message:
          isClaimRefusal(cause) || isClaimUnavailable(cause)
            ? cause.message
            : `Could not take the native-run claim at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    const claim = attempt.acquired;
    if (claim) {
      return {
        release: () => {
          if (!releaseClaim(claim)) {
            console.error(`stim-server: could not release the native-run claim at ${path}; remove it by hand.`);
          }
        },
      };
    }
    const holder = attempt.held ?? attempt.waitingFor?.[0];
    if (Date.now() >= deadline) {
      return {
        code: 'action-failed',
        busy: true,
        message: `${holder ? describeHolder(holder) : 'Another Stim run'} still holds this workspace's native-run claim at ${path} after ${Math.round(waitMs / 1000)} s, and a share starts only while no run, stop or automatic shutdown is changing its devices. Run stim share again once it finishes.`,
      };
    }
    await delay(POLL_MS);
  }
}
