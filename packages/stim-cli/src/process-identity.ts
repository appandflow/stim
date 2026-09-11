import { capture, check, decode } from 'unique-pid';

export interface ProcessRecord {
  pid?: unknown;
  processToken?: unknown;
}

export function sameProcessRecord(a: ProcessRecord | null | undefined, b: ProcessRecord | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.pid === b.pid && a.processToken === b.processToken;
}

export type CapturedIdentity = { ok: true; token: string } | { ok: false; reason: string };

export function captureProcessIdentity(pid: number): CapturedIdentity {
  const result = capture(pid);
  if (result.ok) return { ok: true, token: result.value };
  return { ok: false, reason: `${result.error.code} (${result.error.message})` };
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

export async function waitForProcessExit(record: ProcessRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const identity = inspectProcessIdentity(record);
    if (identity === 'different' || identity === 'gone') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
