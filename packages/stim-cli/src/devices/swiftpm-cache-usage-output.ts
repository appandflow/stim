import chalk from 'chalk';
import type { SwiftpmCacheUsage } from '@stim-cli/core/state';
import { formatBytes } from '../fs-util.ts';
import { formatLongDuration } from '../command-output.ts';

export function swiftpmCacheLines(usage: SwiftpmCacheUsage | null | undefined, now: number = Date.now()): string[] {
  if (!usage?.present) return [];
  return [
    `SwiftPM cache (${usage.bytes === null ? 'unknown' : formatBytes(usage.bytes).replace(/([KMG])$/, ' $1B')}${usage.complete ? '' : ', incomplete'}) - measured ${formatLongDuration(Math.max(0, now - Date.parse(usage.measuredAt)))} ago`,
    `  ${usage.dir}`,
    chalk.dim('  shared by every SwiftPM build on this machine; Stim reports it and never deletes it'),
  ];
}
