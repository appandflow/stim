import { readHostedAppMetadata, type HostedDeviceSession } from '@stim-cli/core/state';
import type { HostedSessionRow } from './protocol.ts';

function buildHostedSessionRows(
  records: HostedDeviceSession[],
  clients: { id: string; name: string }[],
  apps: ReadonlyMap<string, string>,
): HostedSessionRow[] {
  return records
    .flatMap((record): HostedSessionRow[] => {
      const parked = record.parked;
      if (record.state === 'stopped' && !parked) return [];
      const device = record.device;
      return [
        {
          id: record.id,
          client: {
            id: record.client,
            name: clients.find((client) => client.id === record.client)?.name ?? record.client,
          },
          platform: record.platform,
          device:
            device === null
              ? null
              : 'udid' in device
                ? `${device.deviceType} (${device.runtime})`
                : 'avdName' in device
                  ? `${device.deviceProfile} (${device.systemImage.replace('system-images;', '').replaceAll(';', ' ')})`
                  : `macOS app slot ${device.appSlot}`,
          app: apps.get(record.id) ?? null,
          state: record.state,
          parked: parked !== undefined,
          since: parked?.at ?? record.createdAt,
          workspace: record.workspace,
        },
      ];
    })
    .toSorted((a, b) => b.since.localeCompare(a.since));
}

export function readHostedSessionRows(
  records: HostedDeviceSession[],
  clients: { id: string; name: string }[],
): HostedSessionRow[] {
  const apps = new Map<string, string>();
  for (const record of records) {
    if (!record.appAttempt || (record.state === 'stopped' && !record.parked)) continue;
    const app = readHostedAppMetadata(record.id, record.appAttempt);
    if (app.state === 'installed') apps.set(record.id, app.bundleId);
  }
  return buildHostedSessionRows(records, clients, apps);
}

export function formatHostedSessions(rows: HostedSessionRow[]): string[] {
  return rows.length
    ? [
        'Hosted here',
        ...rows.map((row) =>
          `${row.client.name}  ${row.platform}  ${row.device ?? '-'}  ${row.app ?? '-'}  ${row.state}  since ${row.since}`.replace(
            /[\p{Cc}\p{Cf}]/gu,
            '',
          ),
        ),
      ]
    : [];
}
