import type { StimContext } from '@stim-cli/core';
import { formatElapsed } from '../command-output.ts';
import type { ClaimHandle, ClaimHolder } from '../ownership-claim.ts';
import type { ProcessIdentityStatus } from '../process-identity.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { clearWorkspaceStateKey, readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { isTermination, operationState } from './operation-state.ts';
import { allowDeclaredSpawns, refuseDeclaredSpawns, signalDeclaredSpawns } from './spawn-claims.ts';
import { withWorkspaceProcessLock } from './workspace-process-lock.ts';

export const NATIVE_RUN_LOCK = 'native-run';
export const NATIVE_RUN_WAIT_MS: number = 30 * 60_000;
const WAIT_HEARTBEAT_MS = 30_000;
const CANCEL_REQUEST_KEY = 'nativeRunCancel';
const REQUEST_POLL_MS = 250;

export type NativeRunCommand = 'ios' | 'android' | 'macos' | 'build' | 'stop';

export interface NativeRunDetails {
  command: NativeRunCommand;
  platform?: 'ios' | 'android' | 'macos';
  slot?: string;
}

export interface NativeRunHolder {
  command: string | null;
  platform: string | null;
  slot: string;
  /** The holder is a process whose SIGINT cancels the run; otherwise it only reads stop requests. */
  takesSignals: boolean;
}

export function nativeRunHolder(holder: ClaimHolder): NativeRunHolder {
  const { command, platform, slot, interrupt } = holder.details;
  return {
    command: typeof command === 'string' ? command : null,
    platform: typeof platform === 'string' ? platform : null,
    slot: typeof slot === 'string' ? slot : 'default',
    takesSignals: interrupt === 'signal',
  };
}

export function describeNativeRunHolder(holder: ClaimHolder, now: number): string {
  const { command, slot } = nativeRunHolder(holder);
  const started = Date.parse(holder.startedAt);
  const facts = [`pid ${holder.owner.pid}`];
  if (Number.isFinite(started)) facts.push(`running for ${formatElapsed(now - started)}`);
  if (command === null) return `another Stim run (${facts.join(', ')})`;
  if (command === 'build') return `an artifact build (${facts.join(', ')})`;
  return `\`stim ${command}${slot === 'default' ? '' : ` --slot ${slot}`}\` (${facts.join(', ')})`;
}

/**
 * Report a wait on the native-run lock: one line as soon as a holder is seen, a line for each new
 * holder, and a heartbeat every WAIT_HEARTBEAT_MS while the same holder keeps it.
 */
export function nativeRunWaitNotice({
  write,
  now = Date.now,
  describe = describeNativeRunHolder,
}: {
  write: (line: string) => void;
  now?: () => number;
  describe?: (holder: ClaimHolder, now: number) => string;
}): (holder: ClaimHolder, firstLine?: string) => void {
  let claimId: string | null = null;
  let lastAt = 0;
  return (holder, firstLine) => {
    const at = now();
    if (holder.claimId !== claimId) {
      claimId = holder.claimId;
      lastAt = at;
      write(firstLine ?? `waiting for ${describe(holder, at)} in this workspace to finish`);
      return;
    }
    if (at - lastAt < WAIT_HEARTBEAT_MS) return;
    lastAt = at;
    write(`still waiting for ${describe(holder, at)}`);
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
  holder: Omit<NativeRunHolder, 'takesSignals'>;
  ownerIdentity: ProcessIdentityStatus;
  deviceSlots: readonly string[];
}): StopHolderAction {
  if (holder.command === 'macos' || holder.command === 'build') {
    if (stopSlot !== undefined) return { action: 'proceed' };
    return ownerIdentity === 'same' ? { action: 'interrupt' } : { action: 'refuse' };
  }
  if (holder.command !== 'ios' && holder.command !== 'android') return { action: 'wait' };
  const leavesNothing =
    stopSlot === undefined ||
    holder.slot === stopSlot ||
    (deviceSlots.includes(stopSlot) && deviceSlots.every((slot) => slot === stopSlot));
  if (!leavesNothing) return { action: 'proceed' };
  return ownerIdentity === 'same' ? { action: 'interrupt' } : { action: 'refuse' };
}

const requestListeners = new Map<string, () => void>();

/**
 * Ask the run holding `claimId` to cancel: the request is written to the workspace state, where the run's watch
 * finds it, and a run in this process is told at once.
 */
export function requestNativeRunCancel(root: string, claimId: string, pid: number = process.pid): void {
  updateWorkspaceState(root, (state) => ({
    ...state,
    [CANCEL_REQUEST_KEY]: { claimId, pid, at: new Date().toISOString() },
  }));
  requestListeners.get(claimId)?.();
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

/** The active native run of `context`'s operation aborts this signal when it is cancelled. */
export function runCancellationSignal(context: StimContext | undefined): AbortSignal | undefined {
  return operationState(context).runSignal;
}

/** Why `context`'s native run was cancelled, or null while it was not. */
export function runCancellation(context: StimContext | undefined): string | null {
  return operationState(context).cancelled;
}

export function cancelledFailure(
  context: StimContext | undefined,
  platform: 'ios' | 'android',
  { code, message }: { code: string | undefined; message?: string | null },
): { code: string; message: string; remedy: string; lines: string[] } | null {
  const cancelled = runCancellation(context);
  if (cancelled === null || code === 'STIM_CLAIM_UNAVAILABLE') return null;
  return {
    code: 'STIM_CANCELLED',
    message: `The ${platform} run was ${cancelled} before it finished.`,
    remedy: `Run \`stim ${platform}\` again when you want the app on a device.`,
    lines: [`it stopped at ${code ?? 'an unfinished step'}${message ? `: ${message}` : ''}`],
  };
}

function cancelOnAbort({
  context,
  root,
  claim,
  write,
  controller,
}: {
  context: StimContext;
  root: string;
  claim: ClaimHandle;
  write: (line: string) => void;
  controller: AbortController;
}): () => void {
  const state = operationState(context);
  const cancel = () => {
    if (controller.signal.aborted) return;
    const request = cancelRequestFor(root, claim.claimId);
    const cancelled = request ? `cancelled by \`stim stop\` (pid ${request.pid})` : 'cancelled by an interrupt';
    state.cancelled = cancelled;
    state.handled = true;
    controller.abort();
    refuseDeclaredSpawns(context, `the run was ${cancelled}`);
    const signalled = signalDeclaredSpawns(context, 'SIGINT');
    if (signalled > 0 || request) state.draining = true;
    write(
      signalled > 0
        ? `${cancelled}; stopping the running build tool`
        : request
          ? `${cancelled}; stopping before the next build tool or install`
          : cancelled,
    );
  };
  const onAbort = () => {
    if (!isTermination(context.signal.reason)) cancel();
  };
  const onRequest = () => {
    if (controller.signal.aborted || !cancelRequestFor(root, claim.claimId)) return;
    cancel();
    state.abortOperation?.('stop');
  };
  context.signal.addEventListener('abort', onAbort);
  if (context.signal.aborted) onAbort();
  requestListeners.set(claim.claimId, onRequest);
  const watch = setInterval(onRequest, REQUEST_POLL_MS);
  watch.unref();
  return () => {
    clearInterval(watch);
    requestListeners.delete(claim.claimId);
    context.signal.removeEventListener('abort', onAbort);
    allowDeclaredSpawns(context);
    clearNativeRunCancel(root, claim.claimId);
  };
}

/**
 * Run an `ios`, `android` or `macos` invocation under the workspace's native-run lock: the claim records the
 * command, platform and slot, and a wait for another holder is reported on `write`. An abort of `context.signal`
 * forwards an interrupt to the running declared build tool and refuses any later one; a run `stim stop` cancelled
 * stops before its next build tool or install. A `SIGTERM` abort reason is left to the caller.
 */
export function withNativeBuildRun<T>(
  context: StimContext,
  root: string,
  details: NativeRunDetails,
  fn: (claim: ClaimHandle) => Promise<T>,
  { write }: { write: (line: string) => void },
): Promise<T> {
  const notice = nativeRunWaitNotice({ write });
  const state = operationState(context);
  return withWorkspaceProcessLock(
    workspaceDir(root),
    NATIVE_RUN_LOCK,
    async (claim) => {
      state.cancelled = null;
      const controller = new AbortController();
      state.runSignal = controller.signal;
      const dispose = cancelOnAbort({ context, root, claim, write, controller });
      try {
        return await fn(claim);
      } finally {
        dispose();
        state.runSignal = undefined;
      }
    },
    {
      external: true,
      signal: context.signal,
      waitMs: NATIVE_RUN_WAIT_MS,
      declareSpawnsFor: context,
      details: { ...details, interrupt: state.takesSignals ? 'signal' : 'request' },
      onHeld: (holder) => notice(holder),
    },
  );
}
