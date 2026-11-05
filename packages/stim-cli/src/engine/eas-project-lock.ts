import { formatElapsed } from '../command-output.ts';
import type { ClaimHolder } from '../ownership-claim.ts';
import { withWorkspaceProcessLock, type WorkspaceProcessLockOptions } from './workspace-process-lock.ts';
import { assertEasMachineRootWritable, easMachineStateRoot } from './eas-session-ledger.ts';

const EAS_PROJECT_LOCK_WAIT_MS = 4 * 60_000;

export function describeEasProjectLockHolder(holder: ClaimHolder, now: number): string {
  const { purpose, workspace } = holder.details;
  const facts = [`pid ${holder.owner.pid}`];
  if (typeof workspace === 'string') facts.push(`in ${workspace}`);
  const started = Date.parse(holder.startedAt);
  if (Number.isFinite(started)) facts.push(`running for ${formatElapsed(now - started)}`);
  return `${typeof purpose === 'string' ? purpose : 'another Stim EAS operation'} (${facts.join(', ')})`;
}

interface EasProjectLockOptions extends WorkspaceProcessLockOptions {
  machineRoot?: string;
}

export function withEasProjectLock<T>(
  _root: string,
  fn: () => Promise<T>,
  options: EasProjectLockOptions = {},
): Promise<T> {
  const { machineRoot = easMachineStateRoot(), ...lockOptions } = options;
  assertEasMachineRootWritable(machineRoot);
  return withWorkspaceProcessLock(machineRoot, 'eas-project', fn, {
    waitMs: EAS_PROJECT_LOCK_WAIT_MS,
    ...lockOptions,
    external: true,
  });
}
