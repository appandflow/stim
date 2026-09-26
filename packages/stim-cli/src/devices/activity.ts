import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { leaseIsExpired, listLeaseFiles, type LeaseFileEntry } from '../engine/device-lease.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import type { ActivityDriver, DeviceActivity } from '@stim-cli/core/state';

export type { DeviceActivity } from '@stim-cli/core/state';

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const LOG_TAIL_BYTES = 256 * 1024;

export interface ActivityEvidence {
  drivers: (ActivityDriver & { basis: string })[];
  unknown: string[];
  recency: { basis: string; at: number }[];
}

export function classifyActivity(evidence: ActivityEvidence, now: number): DeviceActivity {
  const last = evidence.recency.reduce<{ basis: string; at: number } | null>(
    (best, entry) => (Number.isFinite(entry.at) && (!best || entry.at > best.at) ? entry : best),
    null,
  );
  const lastActivityAt = last ? { lastActivityAt: new Date(last.at).toISOString() } : {};
  const [first] = evidence.drivers;
  if (first) {
    const { basis: _basis, ...driver } = first;
    return {
      state: 'driven',
      driver,
      ...lastActivityAt,
      basis: [...new Set(evidence.drivers.map((entry) => entry.basis))],
    };
  }
  if (evidence.unknown.length) return { state: 'unknown', ...lastActivityAt, basis: [...new Set(evidence.unknown)] };
  const recent = Boolean(last && now - last.at < ACTIVE_WINDOW_MS);
  return {
    state: recent ? 'active' : 'idle',
    ...lastActivityAt,
    basis: [...new Set(evidence.recency.map((entry) => entry.basis))],
  };
}

export function idleForMs(activity: DeviceActivity | null | undefined, now: number): number | null {
  if (activity?.state !== 'idle' || !activity.lastActivityAt) return null;
  const at = Date.parse(activity.lastActivityAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

interface PidStart {
  pid: number;
  startTime: string;
}

export interface AgentDeviceRecord {
  path: string;
  kind: 'claim' | 'runner-lease';
  deviceId: string | null;
  session: string | null;
  workspace: string | null;
  deviceName: string | null;
  readable: boolean;
  owner: PidStart | null;
  runner: PidStart | null;
  createdAtMs: number | null;
}

function field(entry: Record<string, unknown>, pidKey: string, startKey: string): PidStart | null {
  const pid = entry[pidKey];
  const startTime = entry[startKey];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof startTime !== 'string') return null;
  return { pid, startTime };
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseAgentDeviceRecord(
  kind: AgentDeviceRecord['kind'],
  path: string,
  raw: string | null,
): AgentDeviceRecord {
  const entry = parseObject(raw);
  const stem = basename(path, '.json');
  const device = entry?.device && typeof entry.device === 'object' ? (entry.device as Record<string, unknown>) : null;
  const recordedId = kind === 'claim' ? device?.id : entry?.deviceId;
  const deviceId = typeof recordedId === 'string' && recordedId ? recordedId : kind === 'runner-lease' ? stem : null;
  const createdAtMs = typeof entry?.createdAtMs === 'number' ? entry.createdAtMs : null;
  return {
    path,
    kind,
    deviceId,
    session: kind === 'claim' && typeof entry?.session === 'string' && entry.session ? entry.session : null,
    workspace: kind === 'claim' && typeof entry?.workspace === 'string' && entry.workspace ? entry.workspace : null,
    deviceName: kind === 'claim' && typeof device?.name === 'string' ? device.name : null,
    readable: Boolean(entry && deviceId),
    owner: entry ? field(entry, 'ownerPid', 'ownerStartTime') : null,
    runner: entry && kind === 'runner-lease' ? field(entry, 'runnerPid', 'runnerStartTime') : null,
    createdAtMs,
  };
}

export type Liveness = 'live' | 'dead' | 'unknown';

function processMatches(entry: PidStart, startOf: (pid: number) => ProcessStart): Liveness {
  const start = startOf(entry.pid);
  if (start.status === 'gone') return 'dead';
  if (start.status === 'unknown') return 'unknown';
  const recorded = Date.parse(entry.startTime);
  if (!Number.isFinite(recorded)) return 'unknown';
  return Math.floor(start.startedAtMs / 1000) === Math.floor(recorded / 1000) ? 'live' : 'dead';
}

export function agentDeviceLiveness(record: AgentDeviceRecord, startOf: (pid: number) => ProcessStart): Liveness {
  const required = record.kind === 'claim' ? [record.owner] : [record.owner, record.runner];
  const results = required.map((entry) => (entry ? processMatches(entry, startOf) : 'unknown'));
  if (results.includes('dead')) return 'dead';
  if (!record.readable || results.includes('unknown')) return 'unknown';
  return 'live';
}

export interface HostProcess {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
  startedAt: string | null;
  command: string;
}

const HOST_PROCESS_COLUMNS = 'pid=,ppid=,rss=,%cpu=,lstart=,command=';

export function parseProcessTable(output: string): HostProcess[] {
  const rows: HostProcess[] = [];
  for (const line of output.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
        line,
      );
    if (!match) continue;
    const at = Date.parse(match[5]!);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuPercent: Number(match[4]!.replace(',', '.')),
      startedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
      command: match[6]!,
    });
  }
  return rows;
}

function namesDevice(command: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(command);
}

export function driverTool(command: string, id: string): string | null {
  if (!namesDevice(command, id)) return null;
  if (/\bsimctl\s+spawn\b.*\blog\s+stream\b/.test(command) || /\blogcat\b/.test(command)) return null;
  if (/agent-device/i.test(command)) return 'agent-device';
  if (/idb_companion/.test(command)) return 'idb';
  if (/maestro/i.test(command)) return 'maestro';
  if (/appium|WebDriverAgent/i.test(command)) return 'appium';
  if (/\bxcodebuild\b.*\btest(-without-building)?\b/.test(command)) return 'xcodebuild';
  if (/\bsimctl\s+(io|spawn)\b/.test(command)) return 'simctl';
  return null;
}

function parseAndroidInstrumentation(output: string): { pid: number; tool: string }[] {
  const found: { pid: number; tool: string }[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2]!;
    if (/uiautomator/.test(args)) found.push({ pid: Number(match[1]), tool: 'uiautomator' });
    else if (/androidx\.test|\binstrument\b/.test(args)) found.push({ pid: Number(match[1]), tool: 'instrumentation' });
  }
  return found;
}

interface LogRecordTarget {
  platform: 'ios' | 'android';
  id: string;
  slot: string;
}

function latestDeviceLogAt(lines: readonly string[], target: LogRecordTarget): number | null {
  return latestRecordAt(lines, (record) => {
    if (record.src !== 'device' || record.platform !== target.platform || !isDeviceRecord(record)) return false;
    if (target.slot === 'default') return record.slot === undefined;
    return record.slot === target.slot && (record.deviceId === undefined || record.deviceId === target.id);
  });
}

function latestBundleRequestAt(lines: readonly string[], platform: 'ios' | 'android'): number | null {
  return latestRecordAt(lines, (record) => record.event === 'bundle_response_started' && record.platform === platform);
}

function latestRecordAt(
  lines: readonly string[],
  matches: (record: Record<string, unknown>) => boolean,
): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseObject(lines[i]!);
    if (record && typeof record.ts === 'number' && matches(record)) return record.ts;
  }
  return null;
}

function isDeviceRecord(record: Record<string, unknown>): boolean {
  return !(typeof record.event === 'string' && record.event.startsWith('collector_'));
}

function tailLines(path: string): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    return length < size ? lines.slice(1) : lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function envDir(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : null;
}

function agentDeviceDirs(home: string): { kind: AgentDeviceRecord['kind']; dir: string }[] {
  const root = join(home, '.agent-device');
  const leaseDirs = [
    envDir('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR') ?? join(root, 'apple-runner', 'leases'),
    join(root, 'ios-runner', 'leases'),
  ];
  return [
    { kind: 'claim', dir: envDir('AGENT_DEVICE_CLAIMS_DIR') ?? join(root, 'device-claims') },
    ...[...new Set(leaseDirs)].map((dir) => ({ kind: 'runner-lease' as const, dir })),
  ];
}

export function readAgentDeviceRecords(home: string): AgentDeviceRecord[] {
  return agentDeviceDirs(home).flatMap(({ kind, dir }) => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    return names.map((name) => {
      const path = join(dir, name);
      let raw: string | null = null;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {}
      return parseAgentDeviceRecord(kind, path, raw);
    });
  });
}

export interface ActivityTarget extends LogRecordTarget {
  workspace: string | null;
}

export interface DeviceProcessTables {
  host(): HostProcess[] | null;
  android(serial: string): string | null;
}

export function createDeviceProcessTables(): DeviceProcessTables {
  const exec = getExecutor();
  let host: HostProcess[] | null | undefined;
  const android = new Map<string, string | null>();
  return {
    host() {
      if (host === undefined) {
        const output = exec.runFileQuiet('ps', ['-axww', '-o', HOST_PROCESS_COLUMNS], { timeoutMs: 5000 });
        host = output === null ? null : parseProcessTable(output);
      }
      return host;
    },
    android(serial) {
      if (!android.has(serial)) {
        android.set(
          serial,
          exec.runFileQuiet('adb', ['-s', serial, 'shell', 'ps', '-A', '-o', 'PID,ARGS'], { timeoutMs: 5000 }),
        );
      }
      return android.get(serial) ?? null;
    },
  };
}

export interface ActivityReaderOptions {
  now?: number;
  home?: string;
  startOf?: (pid: number) => ProcessStart;
  leaseFiles?: () => LeaseFileEntry[];
  tables?: DeviceProcessTables;
}

export function createActivityReader({
  now = Date.now(),
  home = homedir(),
  startOf = inspectProcessStart,
  leaseFiles = listLeaseFiles,
  tables = createDeviceProcessTables(),
}: ActivityReaderOptions = {}): (target: ActivityTarget) => DeviceActivity {
  let agentDevice: { record: AgentDeviceRecord; liveness: Liveness }[] | undefined;
  let stimLeases: LeaseFileEntry[] | undefined;
  const logs = new Map<string, string[] | null>();
  const log = (path: string) => {
    if (!logs.has(path)) logs.set(path, tailLines(path));
    return logs.get(path) ?? null;
  };

  return (target) => {
    const evidence: ActivityEvidence = { drivers: [], unknown: [], recency: [] };

    agentDevice ??= readAgentDeviceRecords(home).map((record) => ({
      record,
      liveness: agentDeviceLiveness(record, startOf),
    }));
    for (const { record, liveness } of agentDevice) {
      if (record.deviceId !== null && record.deviceId !== target.id) continue;
      const basis = record.kind === 'claim' ? 'agent-device-claim' : 'agent-device-lease';
      if (liveness === 'live') {
        evidence.drivers.push({
          basis,
          tool: 'agent-device',
          pid: record.owner?.pid ?? null,
          since: record.createdAtMs !== null ? new Date(record.createdAtMs).toISOString() : null,
        });
      } else if (liveness === 'unknown') {
        evidence.unknown.push(basis);
      }
    }

    try {
      stimLeases ??= leaseFiles();
    } catch {
      stimLeases = [];
      evidence.unknown.push('device-lock');
    }
    for (const entry of stimLeases) {
      if (entry.platform !== target.platform || entry.id !== target.id) continue;
      if (!entry.lease) evidence.unknown.push('device-lock');
      else if (!leaseIsExpired(entry.lease, now))
        evidence.drivers.push({
          basis: 'device-lock',
          tool: 'stim device lock',
          pid: null,
          since: entry.lease.grantedAt,
        });
    }

    const processes = tables.host();
    if (processes === null) evidence.unknown.push('driver-process');
    for (const row of processes ?? []) {
      const tool = driverTool(row.command, target.id);
      if (tool) evidence.drivers.push({ basis: 'driver-process', tool, pid: row.pid, since: row.startedAt });
    }

    if (target.platform === 'android') {
      const output = tables.android(target.id);
      if (output === null) evidence.unknown.push('instrumentation');
      for (const { pid, tool } of parseAndroidInstrumentation(output ?? '')) {
        evidence.drivers.push({ basis: 'instrumentation', tool, pid, since: null });
      }
    }

    if (target.workspace) {
      const dir = workspaceLogsDir(target.workspace);
      const deviceAt = latestDeviceLogAt(log(join(dir, 'device.ndjson')) ?? [], target);
      if (deviceAt !== null) evidence.recency.push({ basis: 'device-log', at: deviceAt });
      const bundleAt = latestBundleRequestAt(log(join(dir, 'metro.ndjson')) ?? [], target.platform);
      if (bundleAt !== null) evidence.recency.push({ basis: 'metro-bundle', at: bundleAt });
      const usedAt = Date.parse(String(readWorkspaceState(target.workspace)?.lastUsedAt ?? ''));
      if (Number.isFinite(usedAt)) evidence.recency.push({ basis: 'workspace-use', at: usedAt });
    }

    return classifyActivity(evidence, now);
  };
}

export function workspaceActivity(workspace: string, now: number = Date.now()): DeviceActivity {
  const dir = workspaceLogsDir(workspace);
  const state = readWorkspaceState(workspace);
  const recency: ActivityEvidence['recency'] = [];
  const deviceAt = latestRecordAt(
    tailLines(join(dir, 'device.ndjson')) ?? [],
    (record) => record.src === 'device' && isDeviceRecord(record),
  );
  if (deviceAt !== null) recency.push({ basis: 'device-log', at: deviceAt });
  const bundleAt = latestRecordAt(
    tailLines(join(dir, 'metro.ndjson')) ?? [],
    (record) => record.event === 'bundle_response_started',
  );
  if (bundleAt !== null) recency.push({ basis: 'metro-bundle', at: bundleAt });
  for (const [basis, value] of [
    ['workspace-use', state?.lastUsedAt],
    ['supervisor-start', state?.supervisor?.startedAt],
  ] as const) {
    const at = Date.parse(String(value ?? ''));
    if (Number.isFinite(at)) recency.push({ basis, at });
  }
  return classifyActivity({ drivers: [], unknown: [], recency }, now);
}
