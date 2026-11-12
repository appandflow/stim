import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { DetachedChildObserver } from '../exec.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  startedNotBefore,
  type ProcessRecord,
} from '../process-identity.ts';

const ENTRY = /^group-[0-9a-f-]+\.json$/;

function write(directory: string, token: string, record: ProcessRecord | null): void {
  const staging = join(directory, `.staging-${token}`);
  writeFileSync(staging, JSON.stringify({ record }), { mode: 0o600 });
  renameSync(staging, join(directory, `group-${token}.json`));
}

export function recordDetachedGroups(directory: string): DetachedChildObserver {
  return {
    begin() {
      const token = randomUUID();
      write(directory, token, null);
      return token;
    },
    started(token, pid) {
      const captured = captureProcessIdentity(pid);
      if (captured.ok) write(directory, token, { pid, processToken: captured.token });
    },
    settled(token) {
      rmSync(join(directory, `group-${token}.json`), { force: true });
    },
  };
}

const OBSERVING = 'observing.json';
const SETTLE_POLL_MS = 25;

export function markObserving(directory: string): void {
  writeFileSync(join(directory, OBSERVING), '{}', { mode: 0o600 });
}

function groupGone(pid: number, processToken: string): boolean {
  return inspectProcessIdentity({ pid, processToken }) === 'gone' && !processGroupAlive(pid);
}

function readRecords(directory: string): ProcessRecord[] | null {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  if (!names.includes(OBSERVING)) return null;
  const records: ProcessRecord[] = [];
  for (const name of names) {
    if (!name.startsWith('group-')) continue;
    if (!ENTRY.test(name)) return null;
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const record = value && typeof value === 'object' && 'record' in value ? value.record : undefined;
      if (
        !record ||
        typeof record !== 'object' ||
        !('pid' in record) ||
        typeof record.pid !== 'number' ||
        !('processToken' in record) ||
        typeof record.processToken !== 'string'
      )
        return null;
      records.push({ pid: record.pid, processToken: record.processToken });
    } catch {
      return null;
    }
  }
  return records;
}

export async function settleDetachedGroups(
  directory: string,
  child: { pid: number; processToken: string } | undefined,
  budgetMs: number,
): Promise<boolean> {
  if (process.platform === 'win32' || !child || !groupGone(child.pid, child.processToken)) return false;
  const records = readRecords(directory);
  if (!records) return false;
  const named: { pid: number; processToken: string }[] = [];
  for (const record of records) {
    if (typeof record.pid !== 'number' || typeof record.processToken !== 'string') return false;
    if (!startedNotBefore(record, child)) return false;
    named.push({ pid: record.pid, processToken: record.processToken });
  }
  for (const record of named) {
    if (inspectProcessIdentity(record) !== 'same') continue;
    try {
      process.kill(-record.pid, 'SIGKILL');
    } catch {}
  }
  const deadline = performance.now() + budgetMs;
  for (;;) {
    let settled = true;
    for (const record of named) {
      const status = inspectProcessIdentity(record);
      if (status !== 'same' && status !== 'gone') return false;
      if (status === 'same' || processGroupAlive(record.pid)) settled = false;
    }
    if (settled) return true;
    if (performance.now() >= deadline) return false;
    await delay(SETTLE_POLL_MS);
  }
}
