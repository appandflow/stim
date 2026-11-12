import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetachedChildObserver } from '../exec.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';

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

function groupGone(pid: number, processToken: string): boolean {
  return inspectProcessIdentity({ pid, processToken }) === 'gone' && !processGroupAlive(pid);
}

export function detachedGroupsGone(directory: string): boolean {
  if (process.platform === 'win32') return false;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.startsWith('group-')) continue;
    if (!ENTRY.test(name)) return false;
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const record = value && typeof value === 'object' && 'record' in value ? value.record : undefined;
      if (
        !record ||
        typeof record !== 'object' ||
        !('pid' in record) ||
        typeof record.pid !== 'number' ||
        !('processToken' in record) ||
        typeof record.processToken !== 'string' ||
        !groupGone(record.pid, record.processToken)
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
