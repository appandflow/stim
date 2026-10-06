import { join } from 'node:path';
import { configDir } from '../index.ts';
import { readJsonObject } from './json-file.ts';

export interface SwiftpmCacheUsage {
  version: 1;
  measuredAt: string;
  dir: string;
  present: boolean;
  bytes: number | null;
  complete: boolean;
}

export function swiftpmCacheUsageFile(): string {
  return join(configDir(), 'swiftpm-cache-usage.json');
}

export function readSwiftpmCacheUsage(): SwiftpmCacheUsage | null {
  const value = readJsonObject(swiftpmCacheUsageFile());
  if (
    !value ||
    value.version !== 1 ||
    typeof value.measuredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.measuredAt)) ||
    typeof value.dir !== 'string' ||
    typeof value.present !== 'boolean' ||
    typeof value.complete !== 'boolean' ||
    !(value.bytes === null || (typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0))
  )
    return null;
  return value as unknown as SwiftpmCacheUsage;
}
