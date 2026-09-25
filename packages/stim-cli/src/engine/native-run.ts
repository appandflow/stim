import { formatElapsed } from '../command-output.ts';
import type { ClaimHandle, ClaimHolder } from '../ownership-claim.ts';
import type { ProcessIdentityStatus } from '../process-identity.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { clearWorkspaceStateKey, readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { allowDeclaredSpawns, refuseDeclaredSpawns, signalDeclaredSpawns } from './spawn-claims.ts';
import { withWorkspaceProcessLock } from './workspace-process-lock.ts';

export const NATIVE_RUN_LOCK = 'native-run';
export const NATIVE_RUN_WAIT_MS: number = 30 * 60_000;
const WAIT_HEARTBEAT_MS = 30_000;
const CANCEL_REQUEST_KEY = 'nativeRunCancel';

export type NativeRunCommand = 'ios' | 'android' | 'stop';

export interface NativeRunDetails {
  command: NativeRunCommand;
  platform?: 'ios' | 'android';
  slot?: string;
}

export interface NativeRunHolder {
  command: string | null;
  platform: string | null;
  slot: string;
}

export function nativeRunHolder(holder: ClaimHolder): NativeRunHolder {
  const { command, platform, slot } = holder.details;
  return {
    command: typeof command === 'string' ? command : null,
    platform: typeof platform === 'string' ? platform : null,
    slot: typeof slot === 'string' ? slot : 'default',
  };
}

export function describeNativeRunHolder(holder: ClaimHolder, now: number): string {
  const { command, slot } = nativeRunHolder(holder);
  const started = Date.parse(holder.startedAt);
  const facts = [`pid ${holder.owner.pid}`];
  if (Number.isFinite(started)) facts.push(`running for ${formatElapsed(now - started)}`);
  if (command === null) return `another Stim run (${facts.join(', ')})`;
  return `\`stim ${command}${slot === 'default' ? '' : ` --slot ${slot}`}\` (${facts.join(', ')})`;
}

/**
 * Report a wait on the native-run lock: one line as soon as a holder is seen, a line for each new
 * holder, and a heartbeat every WAIT_HEARTBEAT_MS while the same holder keeps it.
 */
export function nativeRunWaitNotice({
  write,
  now = Date.now,
}: {
  write: (line: string) => void;
  now?: () => number;
}): (holder: ClaimHolder, firstLine?: string) => void {
  let claimId: string | null = null;
  let lastAt = 0;
  return (holder, firstLine) => {
    const at = now();
    if (holder.claimId !== claimId) {
      claimId = holder.claimId;
      lastAt = at;
      write(firstLine ?? `waiting for ${describeNativeRunHolder(holder, at)} in this workspace to finish`);
      return;
    }
    if (at - lastAt < WAIT_HEARTBEAT_MS) return;
    lastAt = at;
    write(`still waiting for ${describeNativeRunHolder(holder, at)}`);
  };
}

export type StopHolderAction =
  | { action: 'interrupt' }
  | { action: 'wait' }
  | { action: 'proceed' }
  | { action: 'refuse' };

/**
 * What `stop` does about the run holding the native-run lock. A build is interrupted only when the stop
 * leaves it nothing to deploy to: the whole workspace stops, the build targets the stopped slot, or the
 * stopped slot is the workspace's only device. A build for another slot that stays is left running and
 * the stop proceeds without the lock. Only an owner whose identity is proven live is signalled.
 */
export function decideStopAction({
  stopSlot,
  holder,
  ownerIdentity,
  deviceSlots,
}: {
  stopSlot: string | undefined;
  holder: NativeRunHolder;
  ownerIdentity: ProcessIdentityStatus;
  deviceSlots: readonly string[];
}): StopHolderAction {
  if (holder.command !== 'ios' && holder.command !== 'android') return { action: 'wait' };
  const leavesNothing =
    stopSlot === undefined || holder.slot === stopSlot || deviceSlots.every((slot) => slot === stopSlot);
  if (!leavesNothing) return { action: 'proceed' };
  return ownerIdentity === 'same' ? { action: 'interrupt' } : { action: 'refuse' };
}

export function requestNativeRunCancel(root: string, claimId: string, pid: number = process.pid): void {
  updateWorkspaceState(root, (state) => ({
    ...state,
    [CANCEL_REQUEST_KEY]: { claimId, pid, at: new Date().toISOString() },
  }));
}

function cancelRequestFor(root: string, claimId: string): { pid: number } | null {
  const request = readWorkspaceState(root)?.[CANCEL_REQUEST_KEY] as { claimId?: unknown; pid?: unknown } | undefined;
  if (request?.claimId !== claimId || typeof request.pid !== 'number') return null;
  return { pid: request.pid };
}

export function clearNativeRunCancel(root: string, claimId: string): void {
  try {
    clearWorkspaceStateKey(root, CANCEL_REQUEST_KEY, (value) => (value as { claimId?: unknown })?.claimId === claimId);
  } catch {}
}

let cancelled: string | null = null;

/** Why this process's native run was cancelled, or null while it was not. */
export function runCancellation(): string | null {
  return cancelled;
}

export function cancelledFailure(
  platform: 'ios' | 'android',
  { code, message }: { code: string | undefined; message?: string | null },
): { code: string; message: string; remedy: string; lines: string[] } | null {
  if (cancelled === null) return null;
  return {
    code: 'STIM_CANCELLED',
    message: `The ${platform} run was ${cancelled} before it finished.`,
    remedy: `Run \`stim ${platform}\` again when you want the app on a device.`,
    lines: [`it stopped at ${code ?? 'an unfinished step'}${message ? `: ${message}` : ''}`],
  };
}

function cancelOnInterrupt({
  root,
  claim,
  write,
  exit,
}: {
  root: string;
  claim: ClaimHandle;
  write: (line: string) => void;
  exit: (code: number) => void;
}): () => void {
  let signals = 0;
  const onInterrupt = () => {
    signals += 1;
    if (signals > 1) {
      exit(130);
      return;
    }
    const request = cancelRequestFor(root, claim.claimId);
    cancelled = request ? `cancelled by \`stim stop\` (pid ${request.pid})` : 'cancelled by an interrupt';
    refuseDeclaredSpawns(`the run was ${cancelled}`);
    const signalled = signalDeclaredSpawns('SIGINT');
    write(
      signalled > 0
        ? `${cancelled}; stopping the running build tool`
        : request
          ? `${cancelled}; finishing the current step without starting another build tool`
          : cancelled,
    );
    if (signalled === 0 && !request) exit(130);
  };
  process.on('SIGINT', onInterrupt);
  return () => {
    process.off('SIGINT', onInterrupt);
    allowDeclaredSpawns();
    clearNativeRunCancel(root, claim.claimId);
  };
}

/**
 * Run an `ios` or `android` invocation under the workspace's native-run lock: the claim records the
 * command, platform and slot, and a wait for another holder is reported on `write`. The first SIGINT
 * forwards the interrupt to the running declared build tool; a run `stim stop` cancelled between build
 * tools starts no further one; a terminal interrupt with no build tool running, or a second SIGINT, exits
 * with 130 at once.
 */
export function withNativeBuildRun<T>(
  root: string,
  details: NativeRunDetails,
  fn: (claim: ClaimHandle) => Promise<T>,
  { write, exit = (code) => process.exit(code) }: { write: (line: string) => void; exit?: (code: number) => void },
): Promise<T> {
  const notice = nativeRunWaitNotice({ write });
  return withWorkspaceProcessLock(
    workspaceDir(root),
    NATIVE_RUN_LOCK,
    async (claim) => {
      const dispose = cancelOnInterrupt({ root, claim, write, exit });
      try {
        return await fn(claim);
      } finally {
        dispose();
      }
    },
    {
      external: true,
      waitMs: NATIVE_RUN_WAIT_MS,
      declareSpawns: true,
      details: { ...details },
      onHeld: (holder) => notice(holder),
    },
  );
}
