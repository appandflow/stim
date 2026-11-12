import type { ChildProcess } from 'node:child_process';
import { capture, check, decode } from 'unique-pid';

export interface ProcessRecord {
  pid?: unknown;
  processToken?: unknown;
}

export function sameProcessRecord(a: ProcessRecord | null | undefined, b: ProcessRecord | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.pid === b.pid && a.processToken === b.processToken;
}

export type CapturedIdentity = { ok: true; token: string } | { ok: false; reason: string; code?: string };

export function captureProcessIdentity(pid: number): CapturedIdentity {
  const result = capture(pid);
  if (result.ok) return { ok: true, token: result.value };
  return { ok: false, reason: `${result.error.code} (${result.error.message})`, code: result.error.code };
}

export const EXITED_CHILD_GRACE_MS = 2000;

type ObservableChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'once'>;

/**
 * A child that exited before its identity was read is a zombie, and capture reports `NOT_FOUND` for it. That code is
 * not proof of exit: a live process misread as not found would run with no claim record. After a `NOT_FOUND`
 * capture, this resolves true only once the child's own `exit` is seen, and false when it is not seen within `graceMs`.
 */
export function childExitedWithin(child: ObservableChild, graceMs: number = EXITED_CHILD_GRACE_MS): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Runs `onLive` when a child whose capture read `NOT_FOUND` has not been seen to exit; see {@link childExitedWithin}.
 * A throwing `onLive` is logged, not raised, so it cannot become an unhandled rejection.
 */
export function unlessChildExits(child: ObservableChild, onLive: () => void, graceMs?: number): void {
  void (async () => {
    if (await childExitedWithin(child, graceMs)) return;
    try {
      onLive();
    } catch (error) {
      console.error(`stim: a child whose identity was not found could not be handled: ${String(error)}`);
    }
  })();
}

/**
 * For a caller that must record a child's identity but read `NOT_FOUND`: when the child's own exit is not seen within
 * the grace, a live process is capturable, so read it again and give the token to `record`. A child that still cannot
 * be read, or whose record fails, is stopped through its handle, so nothing runs without a record.
 */
export function recordIdentityUnlessExited(
  child: ObservableChild & Pick<ChildProcess, 'pid' | 'kill'>,
  record: (token: string) => void,
  graceMs?: number,
): void {
  unlessChildExits(
    child,
    () => {
      const again = child.pid === undefined ? null : captureProcessIdentity(child.pid);
      try {
        if (!again?.ok) throw new Error('identity unreadable');
        record(again.token);
      } catch {
        child.kill('SIGKILL');
      }
    },
    graceMs,
  );
}

export function captureProcessToken(pid: number): string | null {
  const captured = captureProcessIdentity(pid);
  return captured.ok ? captured.token : null;
}

export type ProcessIdentityStatus = 'same' | 'different' | 'gone' | 'unknown';

export function inspectProcessIdentity(record: ProcessRecord | null | undefined): ProcessIdentityStatus {
  if (!record || typeof record.processToken !== 'string') return 'unknown';
  const decoded = decode(record.processToken);
  if (!decoded.ok || decoded.value.pid !== record.pid) return 'unknown';
  const result = check(record.processToken);
  return result.ok ? result.value : 'unknown';
}

function startOf(record: ProcessRecord): bigint | null {
  if (typeof record.processToken !== 'string') return null;
  const decoded = decode(record.processToken);
  if (!decoded.ok) return null;
  const match = /^(\d+)(?::(\d+))?$/.exec(String(decoded.value.startTime));
  if (!match) return null;
  return BigInt(match[1] ?? '0') * 1_000_000n + BigInt(match[2] ?? '0');
}

/** Whether `record` started at or after `reference`; false when either start time cannot be read. */
export function startedNotBefore(record: ProcessRecord, reference: ProcessRecord): boolean {
  const started = startOf(record);
  const earlier = startOf(reference);
  return started !== null && earlier !== null && started >= earlier;
}

export type ProcessStart = { status: 'running'; startedAtMs: number } | { status: 'gone' } | { status: 'unknown' };

/** Start time of a live process, read from the same OS identity that `captureProcessIdentity` records. */
export function inspectProcessStart(pid: number): ProcessStart {
  const result = processStartMicros(pid);
  return result.status === 'running'
    ? { status: 'running', startedAtMs: Math.floor(result.startedAtMicros / 1000) }
    : result;
}

/** Exact Darwin process start time for a native viewer that revalidates the same owned process. */
export function processStartMicros(
  pid: number,
): { status: 'running'; startedAtMicros: number } | { status: 'gone' | 'unknown' } {
  const captured = capture(pid);
  if (!captured.ok) return captured.error.code === 'NOT_FOUND' ? { status: 'gone' } : { status: 'unknown' };
  const decoded = decode(captured.value);
  if (!decoded.ok || decoded.value.platform !== 'darwin') return { status: 'unknown' };
  const match = /^(\d+):(\d+)$/.exec(decoded.value.startTime);
  if (!match) return { status: 'unknown' };
  return { status: 'running', startedAtMicros: Number(match[1]) * 1_000_000 + Number(match[2]) };
}

export async function waitForProcessExit(
  record: ProcessRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    signal?.throwIfAborted();
    const identity = inspectProcessIdentity(record);
    if (identity === 'different' || identity === 'gone') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signal?.throwIfAborted();
  return false;
}
