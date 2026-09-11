import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

const DEFAULT_WAIT_MS = 60_000;
const POLL_MS = 25;

export interface WorkspaceProcessLockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  ownerPurpose?: string;
  rejectOwnerPurposes?: readonly string[];
  external?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function workspaceProcessLockError(err: unknown): 'refused' | 'timeout' | null {
  const code = (err as Error & { code?: string })?.code;
  if (code === 'STIM_LOCK_REFUSED') return 'refused';
  if (code === 'STIM_LOCK_TIMEOUT') return 'timeout';
  return null;
}

function lockPath(root: string, name: string, external: boolean): string {
  return external ? join(root, `${name}.lock`) : join(root, '.stim', `${name}.lock`);
}

export async function withWorkspaceProcessLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  {
    now = Date.now,
    sleep = defaultSleep,
    waitMs = DEFAULT_WAIT_MS,
    ownerPurpose,
    rejectOwnerPurposes = [],
    external = false,
  }: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const path = lockPath(root, name, external);
  const deadline = now() + waitMs;

  for (;;) {
    const attempt = tryAcquireClaim({
      root: path,
      mode: 'exclusive',
      label: `${name} lock`,
      details: ownerPurpose ? { purpose: ownerPurpose } : {},
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) {
      try {
        return await fn();
      } finally {
        releaseClaim(attempt.acquired);
      }
    }

    const holder = attempt.held ?? attempt.waitingFor?.[0];
    const purpose = holder?.details.purpose;
    if (typeof purpose === 'string' && rejectOwnerPurposes.includes(purpose)) {
      const error = new Error(`The ${name} lock at ${path} is held for ${purpose}.`);
      (error as Error & { code?: string }).code = 'STIM_LOCK_REFUSED';
      throw error;
    }
    if (now() >= deadline) {
      const error = new Error(`Timed out waiting for the ${name} lock at ${path}.`);
      (error as Error & { code?: string }).code = 'STIM_LOCK_TIMEOUT';
      throw error;
    }
    await sleep(POLL_MS);
  }
}
