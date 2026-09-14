import { configDir } from '@stim-cli/core';
import { join } from 'node:path';
import { ClaimRefusedError, releaseClaim, tryAcquireClaim, type ClaimHandle } from './ownership-claim.ts';

export function acquireAvdClaim(avdName: string): ClaimHandle {
  const root = join(configDir(), 'avd-locks', `${encodeURIComponent(avdName.toLowerCase())}.lock`);
  const label = `AVD ${avdName}`;
  const attempt = tryAcquireClaim({ root, mode: 'exclusive', label });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (attempt.acquired) return attempt.acquired;
  throw new ClaimRefusedError({
    root,
    claimPath: attempt.held?.path ?? attempt.waitingFor?.[0]?.path ?? root,
    label,
    reason: 'another operation is creating, recovering, or tearing down this AVD',
  });
}
