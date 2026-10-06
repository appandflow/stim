import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import {
  isJsonObject,
  parseHostedLogsCursor,
  type HostedLogsCursor,
  type HostedMacosPlacement,
  type HostedIosPlacement,
} from '@stim-cli/core/state';
import { deviceSlotFileKey, validateDeviceSlot } from '../devices/device-slots.ts';
import { macosDir } from '../macos/state.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { call, type HostConnection } from './hosted-client.ts';

const MAX_PAGES = 64;

type LogTarget = { platform: 'ios' | 'macos'; slot: string };
const MACOS: LogTarget = { platform: 'macos', slot: 'default' };
const logsStateDir = (root: string, target: LogTarget): string =>
  target.platform === 'macos' ? macosDir(root) : join(workspaceDir(root), 'ios', validateDeviceSlot(target.slot));
const cursorFile = (root: string, target: LogTarget): string =>
  join(logsStateDir(root, target), 'host-logs-cursor.json');
const hostLogFile = (root: string, target: LogTarget): string =>
  join(
    workspaceLogsDir(root),
    `${target.platform === 'macos' ? 'macos' : deviceSlotFileKey('ios', target.slot)}-host.ndjson`,
  );

function readCursor(root: string, session: string, target: LogTarget): HostedLogsCursor | undefined {
  try {
    const stored: unknown = JSON.parse(readFileSync(cursorFile(root, target), 'utf8'));
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
  target: LogTarget,
): void {
  if (!records.length && sameCursor(before, cursor)) return;
  const directory = logsStateDir(root, target);
  withDirLock(
    join(directory, 'host-logs.lock'),
    () => {
      if (!sameCursor(readCursor(root, session, target), before)) return;
      if (records.length) {
        const writer = createNdjsonWriter(hostLogFile(root, target), {
          maxBytes: LOG_ROTATE_BYTES,
        });
        try {
          for (const record of records)
            writer.write(
              target.platform === 'ios'
                ? { ...record, src: 'device', platform: 'ios', slot: target.slot, event: 'hosted_native_log' }
                : record,
            );
        } finally {
          writer.close();
        }
      }
      const temporary = `${cursorFile(root, target)}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ session, cursor }), {
          mode: 0o600,
        });
        renameSync(temporary, cursorFile(root, target));
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    { ensureParent: () => mkdirSync(directory, { recursive: true }) },
  );
}

export async function pullHostedMacosLogs(
  root: string,
  placement: HostedMacosPlacement | HostedIosPlacement,
  host: HostConnection,
  target: LogTarget = MACOS,
  maxPages: number = MAX_PAGES,
): Promise<void> {
  for (let page = 0; page < maxPages; page++) {
    const before = readCursor(root, placement.session, target);
    const result = await call(host, 'device-host.logs.query', {
      session: placement.session,
      ...(before ? { cursor: before } : {}),
    });
    const cursor = isJsonObject(result) ? parseHostedLogsCursor(result.cursor) : null;
    if (
      !isJsonObject(result) ||
      !cursor ||
      !Array.isArray(result.records) ||
      !result.records.every(isJsonObject) ||
      typeof result.more !== 'boolean'
    )
      throw new Error(`${host.machine} answered device-host.logs.query with an unexpected result.`);
    commitPage(root, placement.session, before, result.records, cursor, target);
    if (!result.more || (target.platform === 'macos' && sameCursor(cursor, before))) return;
  }
  if (target.platform === 'ios')
    throw new Error('Hosted native logs still have unread pages; run stim logs again before stopping.');
}

export async function pullHostedIosLogs(
  root: string,
  slot: string,
  placement: HostedIosPlacement,
  host: HostConnection,
  final = false,
): Promise<void> {
  if (!host.connection.supports('hosted-ios-data'))
    throw new Error(`${host.machine} needs a newer stim-server to collect hosted iOS native logs.`);
  await pullHostedMacosLogs(root, placement, host, { platform: 'ios', slot }, final ? Infinity : MAX_PAGES);
}
