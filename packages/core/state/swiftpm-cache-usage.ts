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
  if (!value) return null;
  const { version, measuredAt, dir, present, bytes, complete } = value;
  if (
    version !== 1 ||
    typeof measuredAt !== 'string' ||
    !Number.isFinite(Date.parse(measuredAt)) ||
    typeof dir !== 'string' ||
    typeof present !== 'boolean' ||
    typeof complete !== 'boolean' ||
    !(bytes === null || (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0))
  )
    return null;
  return { version, measuredAt, dir, present, bytes, complete };
}
