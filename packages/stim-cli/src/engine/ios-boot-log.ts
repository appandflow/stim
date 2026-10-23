import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

export type IosBootRecorder = (
  event: string,
  fields: Record<string, unknown> & { msg: string; level?: 'info' | 'warn' },
) => void;

/** Appends records for one simulator to the workspace's device.ndjson; a failed write never fails the boot. */
export function iosBootRecorder(root: string, slot: string | undefined, udid: string): IosBootRecorder {
  return (event, { level = 'info', ...fields }) => {
    try {
      const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'device.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
      writer.write({
        src: 'device',
        platform: 'ios',
        level,
        event,
        deviceId: udid,
        ...(slot && slot !== 'default' ? { slot } : {}),
        ...fields,
      });
      writer.close();
    } catch {}
  };
}
