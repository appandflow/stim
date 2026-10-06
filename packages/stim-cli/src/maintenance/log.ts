import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, rotatedLogPath, withDirLock } from '@stim-cli/core';
import { maintenanceNdjsonFile, workspaceLogsDir, type MaintenanceRecord } from '@stim-cli/core/state';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import type { MaintenanceSettings } from './settings.ts';

interface MaintenanceLogger {
  write(
    event: MaintenanceRecord['event'],
    level: MaintenanceRecord['level'],
    msg: string,
    fields?: Record<string, unknown>,
  ): MaintenanceRecord | null;
  close(): ReturnType<NdjsonWriter['close']>;
}

export function maintenanceLogger(settings: MaintenanceSettings, pass: string, trigger: string): MaintenanceLogger {
  const file = maintenanceNdjsonFile();
  const rotated = rotatedLogPath(file);
  withDirLock(`${file}.lock`, () => {
    try {
      if (Date.now() - statSync(rotated).mtimeMs > settings.logRetentionDays * 86_400_000) unlinkSync(rotated);
    } catch {}
  });
  const writer = createNdjsonWriter(file, {
    maxBytes: settings.logMaxMb * 1024 ** 2,
  });
  return {
    write(
      event: MaintenanceRecord['event'],
      level: MaintenanceRecord['level'],
      msg: string,
      fields: Record<string, unknown> = {},
    ): MaintenanceRecord | null {
      if (level === 'debug' && !settings.logChecks) return null;
      const record: MaintenanceRecord = {
        ...fields,
        ts: Date.now(),
        src: 'maintenance',
        level,
        msg,
        event,
        pass,
        trigger,
        mode: 'report',
      };
      if (!writer.write(record)) throw writer.lastError ?? new Error(`Could not append ${file}`);
      if (
        typeof fields.workspace === 'string' &&
        ['maintenance_action', 'maintenance_failure', 'maintenance_skip'].includes(event)
      ) {
        const workspace = createNdjsonWriter(join(workspaceLogsDir(fields.workspace), 'maintenance.ndjson'), {
          maxBytes: LOG_ROTATE_BYTES,
        });
        try {
          if (!workspace.write(record))
            throw workspace.lastError ?? new Error('Could not append workspace maintenance log');
        } finally {
          workspace.close();
        }
      }
      return record;
    },
    close: () => writer.close(),
  };
}
