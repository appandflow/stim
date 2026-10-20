import { randomBytes } from 'node:crypto';
import { ambientContext } from '../context.ts';

export const RUN_ID_ENV = 'STIM_RUN_ID';

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A run id as the CLI and stim-server accept it: letters, digits, `.`, `_` and `-`, at most 64. Null otherwise. */
export function validRunId(value: unknown): string | null {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value) ? value : null;
}

let current: string | null = null;

/**
 * The run id of the ambient operation context, else of this CLI invocation: `STIM_RUN_ID` when it holds a valid id
 * (Stim Desktop passes one), else a random one. The CLI entry exports it back to `STIM_RUN_ID` so processes the run
 * starts inherit it; this function does not.
 */
export function runId(env: NodeJS.ProcessEnv = process.env): string {
  const context = ambientContext();
  if (context) return context.runId;
  if (current === null) {
    current = validRunId(env[RUN_ID_ENV]) ?? randomBytes(6).toString('hex');
  }
  return current;
}
