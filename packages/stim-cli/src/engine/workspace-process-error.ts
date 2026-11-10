import { claimRemoveCommand, type ClaimHandle } from '../ownership-claim.ts';

export class WorkspaceProcessCleanupError extends Error {
  readonly code = 'STIM_CLAIM_UNAVAILABLE';
  readonly reportCleanup = true;
  readonly claims: readonly ClaimHandle[];
  readonly remedy: string;
  readonly reportResourceSettled?: () => boolean;
  readonly cleanupSettled?: () => boolean;

  constructor(claims: readonly ClaimHandle[], message: string, remedy: string, cause?: Error) {
    super(`${message} Its ownership claims remain held at ${claims.map((claim) => claim.path).join(', ')}.`, { cause });
    this.claims = claims;
    this.remedy = `${remedy} After verifying no child remains, remove only these claims: ${claims.map((claim) => claimRemoveCommand(claim.path)).join('; ')}`;
    const resourceSettled = cause && 'reportResourceSettled' in cause ? cause.reportResourceSettled : undefined;
    if (typeof resourceSettled === 'function') this.reportResourceSettled = () => resourceSettled() === true;
    const cleanupSettled = cause && 'cleanupSettled' in cause ? cause.cleanupSettled : undefined;
    if (typeof cleanupSettled === 'function') this.cleanupSettled = () => cleanupSettled() === true;
  }
}
