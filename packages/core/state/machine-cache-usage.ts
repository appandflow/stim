import { join } from 'node:path';
import { configDir } from '../index.ts';
import { readJsonObject } from './json-file.ts';

export interface SimRuntimeUsage {
  identifier: string;
  runtimeIdentifier: string;
  version: string | null;
  build: string | null;
  bytes: number | null;
  deletable: boolean;
  lastUsedAt: string | null;
  devices: number;
}

/** The cached measurement of other tools' machine-wide caches that gc reports and never deletes. */
export interface MachineCacheUsage {
  version: 1;
  measuredAt: string;
  roots: string[];
  sizes: { dir: string; bytes: number | null }[];
  runtimes: SimRuntimeUsage[] | null;
  agentDeviceVersion: string | null;
  xcodeBuildVersion: string | null;
}

export function machineCacheUsageFile(): string {
  return join(configDir(), 'machine-cache-usage.json');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bytes(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validRuntime(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.identifier === 'string' &&
    typeof value.runtimeIdentifier === 'string' &&
    nullableString(value.version) &&
    nullableString(value.build) &&
    bytes(value.bytes) &&
    typeof value.deletable === 'boolean' &&
    nullableString(value.lastUsedAt) &&
    typeof value.devices === 'number' &&
    Number.isInteger(value.devices) &&
    value.devices >= 0
  );
}

function validUsage(value: Record<string, unknown> | null): value is Record<string, unknown> & MachineCacheUsage {
  return Boolean(
    value &&
    value.version === 1 &&
    typeof value.measuredAt === 'string' &&
    Number.isFinite(Date.parse(value.measuredAt)) &&
    Array.isArray(value.roots) &&
    value.roots.every((root) => typeof root === 'string') &&
    Array.isArray(value.sizes) &&
    value.sizes.every((entry) => object(entry) && typeof entry.dir === 'string' && bytes(entry.bytes)) &&
    (value.runtimes === null || (Array.isArray(value.runtimes) && value.runtimes.every(validRuntime))) &&
    nullableString(value.agentDeviceVersion) &&
    nullableString(value.xcodeBuildVersion),
  );
}

export function readMachineCacheUsage(): MachineCacheUsage | null {
  const value = readJsonObject(machineCacheUsageFile());
  return validUsage(value) ? value : null;
}
