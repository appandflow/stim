import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import { isJsonObject, parseHostedLogsCursor, type HostedLogsCursor } from '@stim-cli/core/state';
import { deviceSlotFileKey, validateDeviceSlot } from '../devices/device-slots.ts';
import { macosDir } from '../macos/state.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { call, type HostConnection } from './hosted-client.ts';

const MAX_PAGES = 64;

type LogTarget = { platform: 'ios' | 'android' | 'macos'; slot: string };
const MACOS: LogTarget = { platform: 'macos', slot: 'default' };
const logsStateDir = (root: string, target: LogTarget): string =>
  target.platform === 'macos'
    ? macosDir(root)
    : join(workspaceDir(root), target.platform, validateDeviceSlot(target.slot));
const cursorFile = (root: string, target: LogTarget): string =>
  join(logsStateDir(root, target), 'host-logs-cursor.json');
const hostLogFile = (root: string, target: LogTarget): string =>
  join(
    workspaceLogsDir(root),
    `${target.platform === 'macos' ? 'macos' : deviceSlotFileKey(target.platform, target.slot)}-host.ndjson`,
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
              target.platform !== 'macos'
                ? { ...record, src: 'device', platform: target.platform, slot: target.slot, event: 'hosted_native_log' }
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
  placement: { session: string },
  host: HostConnection,
  target: LogTarget = MACOS,
  maxPages: number = MAX_PAGES,
  final = false,
): Promise<void> {
  const deadline = Date.now() + (final ? 30_000 : 120_000);
  let checkpoint: number | undefined;
  let progressAt = 0;
  for (let page = 0; page < maxPages && Date.now() < deadline; page++) {
    const before = readCursor(root, placement.session, target);
    if (final && Date.now() >= progressAt) {
      process.stderr.write(`Copying final native logs from ${host.machine} (page ${page + 1})\n`);
      progressAt = Date.now() + 5000;
    }
    const result = await call(
      host,
      'device-host.logs.query',
      {
        session: placement.session,
        ...(before ? { cursor: before } : {}),
      },
      Math.max(1, Math.min(20_000, deadline - Date.now())),
    );
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
    if (!result.more) return;
    const nextCheckpoint = typeof result.checkpoint === 'number' ? result.checkpoint : undefined;
    if (sameCursor(cursor, before) && nextCheckpoint === checkpoint) {
      if (target.platform === 'macos' && !final) return;
      throw new Error('Hosted native logs made no progress; keeping the logs already copied here.');
    }
    checkpoint = nextCheckpoint;
  }
  if (target.platform !== 'macos')
    throw new Error(
      final
        ? 'Final native log copy reached its time or page bound; the host keeps collected logs after stop.'
        : 'Hosted native logs still have unread pages; run stim logs again.',
    );
}

export async function pullHostedNativeLogs(
  root: string,
  slot: string,
  placement: { session: string },
  host: HostConnection,
  final = false,
  platform: 'ios' | 'android' = 'ios',
): Promise<void> {
  if (!host.connection.supports(platform === 'ios' ? 'hosted-ios-data' : 'hosted-android-data'))
    throw new Error(
      `${host.machine} needs a newer stim-server to collect hosted ${platform === 'ios' ? 'iOS' : 'Android'} native logs.`,
    );
  await pullHostedMacosLogs(root, placement, host, { platform, slot }, final ? 1024 : MAX_PAGES, final);
}

export { pullHostedNativeLogs as pullHostedIosLogs };
