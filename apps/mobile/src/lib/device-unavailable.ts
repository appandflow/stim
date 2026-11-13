import { t } from '@lingui/core/macro';

import { unservedReason, type DeviceRef } from '@/lib/workspaces';
import type { ReplayRange } from '@/protocol/types';

export function deviceUnavailable({
  hasStatus,
  workspaceListed,
  pathMissing,
  hasArchive,
  recordingDisabled,
  hasFootage,
  range,
  device,
}: {
  hasStatus: boolean;
  workspaceListed: boolean;
  pathMissing?: boolean;
  hasArchive: boolean;
  recordingDisabled: boolean;
  hasFootage: boolean;
  range: ReplayRange | null;
  device?: DeviceRef;
}): string {
  if (pathMissing) return t`This workspace is no longer on the machine.`;
  if (!device?.running && !hasFootage) {
    if (hasStatus && !workspaceListed && !hasArchive) return t`This workspace is no longer on the machine.`;
    if (recordingDisabled) return t`Recording was off for this workspace.`;
    if (range && range.spans.length === 0) return t`No recording for this device.`;
  }
  return device?.running ? unservedReason(device) : (device?.state ?? t`This device is not running.`);
}
