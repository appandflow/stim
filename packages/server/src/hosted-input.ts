import { ClaimRefusedError, releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';

export function takeHostedInputClaim(session: ClaimHandle): ClaimHandle {
  const root = `${session.root}.input`;
  const attempt = tryAcquireClaim({ root, mode: 'exclusive', label: 'hosted input', details: session.details });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    throw new ClaimRefusedError({
      root,
      claimPath: attempt.held?.path ?? root,
      reason: 'a native input or log process still holds it',
      label: 'hosted input',
    });
  return attempt.acquired;
}
