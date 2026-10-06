import { join } from 'node:path';
import { configDir } from '../index.ts';
import { readJsonObject } from './json-file.ts';

export interface AgentDeviceUsage {
  version: 1;
  measuredAt: string;
  bytes: number;
  complete: boolean;
  stateDir: {
    dir: string;
    present: boolean;
    bytes: number | null;
    sessions: { dir: string; bytes: number | null; count: number };
    logs: { dir: string; bytes: number | null };
    other: { bytes: number | null; largest: { name: string; bytes: number | null }[] };
  };
  runnerBuilds: {
    dir: string;
    present: boolean;
    bytes: number | null;
    sharedBytes: number | null;
    platforms: {
      platform: string;
      dir: string;
      bytes: number | null;
      entries: {
        name: string;
        dir: string;
        bytes: number | null;
        lastUsedAt: string | null;
        packageVersion: string | null;
        xcodeBuildVersion: string | null;
        inUse: boolean;
        inUseReason: 'lease' | 'lock' | 'unreadable' | null;
      }[];
    }[];
  };
  workspaces: { dir: string; projectRoot: string | null; bytes: number | null }[];
  hosted: { dir: string; bytes: number | null; sessions: number } | null;
}

export interface AgentDeviceUsageRoots {
  stateDir: string;
  runnerRoot: string;
  hostedDir: string;
  workspaceDirs: string[];
}

export function agentDeviceUsageFile(): string {
  return join(configDir(), 'agent-device-usage.json');
}

export function readAgentDeviceUsageCache(): { usage: AgentDeviceUsage; roots: AgentDeviceUsageRoots } | null {
  const value = readJsonObject(agentDeviceUsageFile());
  if (!value || value.version !== 1) return null;
  const { roots, ...usage } = value;
  if (!validUsage(usage) || !validRoots(roots)) return null;
  return { usage, roots };
}

export function readAgentDeviceUsage(): AgentDeviceUsage | null {
  const value = readJsonObject(agentDeviceUsageFile());
  if (!value) return null;
  const { roots: _roots, ...usage } = value;
  return validUsage(usage) ? usage : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bytes(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function sized(value: unknown): value is Record<string, unknown> {
  return object(value) && typeof value.dir === 'string' && bytes(value.bytes);
}

function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validRoots(value: unknown): value is AgentDeviceUsageRoots {
  return (
    object(value) &&
    typeof value.stateDir === 'string' &&
    typeof value.runnerRoot === 'string' &&
    typeof value.hostedDir === 'string' &&
    Array.isArray(value.workspaceDirs) &&
    value.workspaceDirs.every((dir) => typeof dir === 'string')
  );
}

function validUsage(value: Record<string, unknown>): value is Record<string, unknown> & AgentDeviceUsage {
  const { stateDir: state, runnerBuilds: runner, workspaces, hosted } = value;
  return (
    value.version === 1 &&
    typeof value.measuredAt === 'string' &&
    Number.isFinite(Date.parse(value.measuredAt)) &&
    typeof value.bytes === 'number' &&
    bytes(value.bytes) &&
    typeof value.complete === 'boolean' &&
    sized(state) &&
    typeof state.present === 'boolean' &&
    sized(state.sessions) &&
    count(state.sessions.count) &&
    sized(state.logs) &&
    object(state.other) &&
    bytes(state.other.bytes) &&
    Array.isArray(state.other.largest) &&
    state.other.largest.every((entry) => object(entry) && typeof entry.name === 'string' && bytes(entry.bytes)) &&
    sized(runner) &&
    typeof runner.present === 'boolean' &&
    bytes(runner.sharedBytes) &&
    Array.isArray(runner.platforms) &&
    runner.platforms.every(
      (platform) =>
        sized(platform) &&
        typeof platform.platform === 'string' &&
        Array.isArray(platform.entries) &&
        platform.entries.every(
          (entry) =>
            sized(entry) &&
            typeof entry.name === 'string' &&
            nullableString(entry.lastUsedAt) &&
            nullableString(entry.packageVersion) &&
            nullableString(entry.xcodeBuildVersion) &&
            typeof entry.inUse === 'boolean' &&
            [null, 'lease', 'lock', 'unreadable'].includes(entry.inUseReason as string | null),
        ),
    ) &&
    Array.isArray(workspaces) &&
    workspaces.every((entry) => sized(entry) && nullableString(entry.projectRoot)) &&
    (hosted === null || (sized(hosted) && count(hosted.sessions)))
  );
}
