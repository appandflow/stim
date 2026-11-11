import { claimRemoveCommand, type ClaimHandle } from '../ownership-claim.ts';

/** The report child whose cleanup could not be verified: its pid, and its identity token when one was captured. */
export interface ReportChild {
  pid: number;
  processToken: string | null;
}

export function reportChildOf(error: unknown): ReportChild | null {
  const child = error && typeof error === 'object' && 'reportChild' in error ? error.reportChild : undefined;
  if (!child || typeof child !== 'object' || !('pid' in child) || typeof child.pid !== 'number') return null;
  const token = 'processToken' in child && typeof child.processToken === 'string' ? child.processToken : null;
  return { pid: child.pid, processToken: token };
}

/**
 * The one identified child behind every one of `errors`, which a retained claim can record instead of an unknown child,
 * or null when any error names no child, a child without an identity token, or a different child.
 */
export function soleReportChild(errors: readonly unknown[]): { pid: number; processToken: string } | null {
  let sole: { pid: number; processToken: string } | null = null;
  for (const error of errors) {
    const child = reportChildOf(error);
    if (!child?.processToken) return null;
    if (sole && (sole.pid !== child.pid || sole.processToken !== child.processToken)) return null;
    sole = { pid: child.pid, processToken: child.processToken };
  }
  return sole;
}

export class WorkspaceProcessCleanupError extends Error {
  readonly code = 'STIM_CLAIM_UNAVAILABLE';
  readonly reportCleanup = true;
  readonly claims: readonly ClaimHandle[];
  readonly remedy: string;
  readonly reportResourceSettled?: () => boolean;
  readonly cleanupSettled?: () => boolean;
  readonly reportChild?: ReportChild;

  constructor(claims: readonly ClaimHandle[], message: string, remedy: string, cause?: Error) {
    super(`${message} Its ownership claims remain held at ${claims.map((claim) => claim.path).join(', ')}.`, { cause });
    this.claims = claims;
    this.remedy = `${remedy} After verifying no child remains, remove only these claims: ${claims.map((claim) => claimRemoveCommand(claim.path)).join('; ')}`;
    const resourceSettled = cause && 'reportResourceSettled' in cause ? cause.reportResourceSettled : undefined;
    if (typeof resourceSettled === 'function') this.reportResourceSettled = () => resourceSettled() === true;
    const cleanupSettled = cause && 'cleanupSettled' in cause ? cause.cleanupSettled : undefined;
    if (typeof cleanupSettled === 'function') this.cleanupSettled = () => cleanupSettled() === true;
    const child = reportChildOf(cause);
    if (child) this.reportChild = child;
  }
}
