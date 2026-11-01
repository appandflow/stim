import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { deviceHostArea, readHostedSessions, type HostedDeviceSession } from '@stim-cli/core/state';
import { isAbsentPath, measuredDirectorySizeAsync } from '../../fs-util.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { describeError } from './eas-sessions.ts';
import { mapLimited, sizeConcurrency } from './limited.ts';

export interface HostedAppStorage {
  session: string;
  client: string;
  platform: HostedDeviceSession['platform'];
  state: HostedDeviceSession['state'];
  path: string;
  appsBytes: number | null;
  blobsBytes: number | null;
  willDelete: false;
  detail: string;
}

export async function collectHostedAppStorage(operation?: StimContext): Promise<{
  areas: HostedAppStorage[];
  notices: string[];
}> {
  const notices: string[] = [];
  let sessions: HostedDeviceSession[];
  try {
    sessions = readHostedSessions();
  } catch (error) {
    return { areas: [], notices: [`Hosted app storage journal unreadable: ${describeError(error)}`] };
  }
  const rows = await mapLimited(
    sessions,
    sizeConcurrency(operation),
    async (record): Promise<HostedAppStorage | null> => {
      operation?.signal.throwIfAborted();
      const path = deviceHostArea(record.id);
      try {
        if (isAbsentPath(path)) return null;
        if (realpathSync(path) !== join(realpathSync(dirname(path)), record.id))
          throw new Error('Session storage resolves outside its owned area.');
        const apps = join(path, 'apps');
        const blobs = join(path, 'blobs');
        if (isAbsentPath(apps) && isAbsentPath(blobs)) return null;
        const measure = async (directory: string) => {
          if (isAbsentPath(directory)) return 0;
          if (!lstatSync(directory).isDirectory()) throw new Error('Hosted app storage is not an owned directory.');
          return measuredDirectorySizeAsync(directory, { timeoutMs: 10_000, operation, signal: operation?.signal });
        };
        return {
          session: record.id,
          client: record.client,
          platform: record.platform,
          state: record.state,
          path,
          appsBytes: await measure(apps),
          blobsBytes: await measure(blobs),
          willDelete: false,
          detail: 'reported only',
        };
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError) throw error;
        operation?.signal.throwIfAborted();
        notices.push(`Hosted app storage ${record.id} unavailable: ${describeError(error)}`);
        return null;
      }
    },
  );
  return { areas: rows.filter((row) => row !== null), notices };
}
