import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import {
  isJsonObject,
  parseHostedLogsCursor,
  type HostedLogsCursor,
  type HostedMacosPlacement,
} from '@stim-cli/core/state';
import { macosDir } from '../macos/state.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import type { HostConnection } from './hosted-macos.ts';

const MAX_PAGES = 64;

const cursorFile = (root: string): string => join(macosDir(root), 'host-logs-cursor.json');
const hostLogFile = (root: string): string => join(workspaceLogsDir(root), 'macos-host.ndjson');

function readCursor(root: string, session: string): HostedLogsCursor | undefined {
  try {
    const stored: unknown = JSON.parse(readFileSync(cursorFile(root), 'utf8'));
    if (isJsonObject(stored) && stored.session === session) return parseHostedLogsCursor(stored.cursor) ?? undefined;
  } catch {}
  return undefined;
}

const sameCursor = (a: HostedLogsCursor | undefined, b: HostedLogsCursor | undefined): boolean =>
  JSON.stringify(Object.entries(a ?? {}).toSorted()) === JSON.stringify(Object.entries(b ?? {}).toSorted());

function commitPage(
  root: string,
  session: string,
  before: HostedLogsCursor | undefined,
  records: Record<string, unknown>[],
  cursor: HostedLogsCursor,
): void {
  if (!records.length && sameCursor(before, cursor)) return;
  const directory = macosDir(root);
  withDirLock(
    join(directory, 'host-logs.lock'),
    () => {
      if (!sameCursor(readCursor(root, session), before)) return;
      if (records.length) {
        const writer = createNdjsonWriter(hostLogFile(root), {
          maxBytes: LOG_ROTATE_BYTES,
        });
        try {
          for (const record of records) writer.write(record);
        } finally {
          writer.close();
        }
      }
      const temporary = `${cursorFile(root)}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ session, cursor }), {
          mode: 0o600,
        });
        renameSync(temporary, cursorFile(root));
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    { ensureParent: () => mkdirSync(directory, { recursive: true }) },
  );
}

export async function pullHostedMacosLogs(
  root: string,
  placement: HostedMacosPlacement,
  host: HostConnection,
): Promise<void> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const before = readCursor(root, placement.session);
    const reply = await host.connection.request('device-host.logs.query', {
      session: placement.session,
      ...(before ? { cursor: before } : {}),
    });
    if ('error' in reply)
      throw Object.assign(new Error(`${host.machine} refused device-host.logs.query: ${reply.error.message}`), {
        code: reply.error.code,
      });
    const result = reply.result;
    const cursor = isJsonObject(result) ? parseHostedLogsCursor(result.cursor) : null;
    if (
      !isJsonObject(result) ||
      !cursor ||
      !Array.isArray(result.records) ||
      !result.records.every(isJsonObject) ||
      typeof result.more !== 'boolean'
    )
      throw new Error(`${host.machine} answered device-host.logs.query with an unexpected result.`);
    commitPage(root, placement.session, before, result.records, cursor);
    if (!result.more || sameCursor(cursor, before)) return;
  }
}
