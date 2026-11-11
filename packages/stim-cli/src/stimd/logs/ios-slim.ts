import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, readCreatedDevices } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import type { NdjsonRecord } from '../../ndjson.ts';
import { launchdLogPath, SIM_SLIM_MANAGED, storedSlimLabels } from '../../engine/simslim.ts';
import { SIM_SLIM_CATEGORIES, SIM_SLIM_FEATURES } from '../../engine/simslim-data.ts';

/** The kernel keeps MAXCOMLEN (16) bytes of a process name, and launchd prints it without the terminator. */
const PROC_NAME_CHARS = 15;
const POLL_MS = 1000;
const READ_LIMIT = 4 * 1024 * 1024;
const PENDING_LIMIT = 1000;
const REPORTED_LIMIT = 256;
const POLL_FAILURE_LIMIT = 3;
const PLUTIL_PARALLEL = 8;
const SIMCTL_TIMEOUT_MS = 30_000;
const PLUTIL_TIMEOUT_MS = 10_000;

export type LaunchdEvent =
  | { kind: 'lookup'; service: string; proc: string; pid: number }
  | { kind: 'spawn' | 'exit'; bundleId: string; pid: number };

/** One line of a simulator's launchd.log: a failed Mach lookup (error 3, no such process), an app's spawn or its exit. */
export function parseLaunchdLine(line: string): LaunchdEvent | null {
  const lookup =
    /failed lookup: name = (?<service>[^,\s]+),.*\brequestor = (?<proc>[^[\]]+)\[(?<pid>\d+)\], error = 3:/.exec(
      line,
    )?.groups;
  if (lookup?.service && lookup.proc)
    return { kind: 'lookup', service: lookup.service, proc: lookup.proc, pid: Number(lookup.pid) };
  const spawn = /\(\S*UIKitApplication:(?<bundleId>[^[\s]+)\[[^)]*\) <\w+>: \S+ spawned with pid (?<pid>\d+)\s*$/.exec(
    line,
  )?.groups;
  if (spawn?.bundleId) return { kind: 'spawn', bundleId: spawn.bundleId, pid: Number(spawn.pid) };
  const exit =
    /\(\S*UIKitApplication:(?<bundleId>[^[\s]+)\[[^)]* \[(?<pid>\d+)\]\) <\w+>: internal event: EXITED\b/.exec(
      line,
    )?.groups;
  if (exit?.bundleId) return { kind: 'exit', bundleId: exit.bundleId, pid: Number(exit.pid) };
  return null;
}

/** Mach service name to launchd label, from a runtime's parsed launchd plists, for the labels in `labels`. */
export function machServiceLabels(plists: readonly unknown[], labels: ReadonlySet<string>): Map<string, string> {
  const services = new Map<string, string>();
  for (const plist of plists) {
    if (!isJsonObject(plist) || typeof plist.Label !== 'string' || !labels.has(plist.Label)) continue;
    if (!isJsonObject(plist.MachServices)) continue;
    for (const service of Object.keys(plist.MachServices)) services.set(service, plist.Label);
  }
  return services;
}

export interface SlimDenial {
  service: string;
  label: string;
  features: string[];
  slimCategory: string | null;
  proc: string;
  pid: number;
  level: 'warn' | 'debug';
  msg: string;
}

/**
 * Where to read the log from next: from the start when the file was replaced (a new inode) or truncated below what
 * was already read, else from where the last read stopped.
 */
export function nextLogOffset(
  read: { ino: number; offset: number },
  file: { ino: number; size: number },
): { offset: number; restarted: boolean } {
  return file.ino !== read.ino || file.size < read.offset
    ? { offset: 0, restarted: true }
    : { offset: read.offset, restarted: false };
}

/**
 * Decides, line by line, which failed lookups to report: the app's own process (its pid from the spawn line for
 * `bundleId`, until its exit line; before any spawn is seen, its executable name) asking for a service of a label in
 * `disabled`, once per feature (or label) per launch.
 */
export function createSlimDenialFilter({
  bundleId,
  executable,
  disabled,
  services,
}: {
  bundleId: string;
  executable: string;
  disabled: ReadonlySet<string>;
  services: ReadonlyMap<string, string>;
}): (event: LaunchdEvent) => SlimDenial | null {
  const name = executable.slice(0, PROC_NAME_CHARS);
  let spawned = false;
  let appPid: number | null = null;
  const reported = new Set<string>();
  return (event) => {
    if (event.kind !== 'lookup') {
      if (event.bundleId !== bundleId) return null;
      if (event.kind === 'exit') {
        if (event.pid === appPid) appPid = null;
      } else if (event.pid !== appPid) {
        spawned = true;
        appPid = event.pid;
        reported.clear();
      }
      return null;
    }
    if (spawned ? event.pid !== appPid : event.proc !== name) return null;
    const label = services.get(event.service);
    if (label === undefined || !disabled.has(label)) return null;
    const features = SIM_SLIM_FEATURES.filter((feature) => feature.labels.includes(label));
    const category = SIM_SLIM_CATEGORIES.find((entry) => entry.labels.includes(label)) ?? null;
    const key = `${event.pid}\0${features.length > 0 ? features.map((feature) => feature.id).join(',') : label}`;
    if (reported.has(key)) return null;
    if (reported.size >= REPORTED_LIMIT) reported.clear();
    reported.add(key);
    const keep = category ? `"except": ["${category.id}"]` : `"keep": ["${label}"]`;
    const asked = `the app asked for ${event.service}, which slimming turned off`;
    return {
      service: event.service,
      label,
      features: features.map((feature) => feature.id),
      slimCategory: category?.id ?? null,
      proc: event.proc,
      pid: event.pid,
      ...(features.length > 0
        ? {
            level: 'warn' as const,
            msg: `${asked} (${features.map((feature) => feature.name).join(', ')}): keep it with ios.simslimProfile (${keep}) or set ios.simslim off -- stim guide lifecycle simslim`,
          }
        : {
            level: 'debug' as const,
            msg: `${asked} (${category?.name ?? label}); no feature Stim lists depends on it`,
          }),
    };
  };
}

const serviceMaps = new Map<string, Promise<Map<string, string>>>();

async function runtimeOf(udid: string, signal: AbortSignal): Promise<{ build: string; root: string }> {
  const listed: unknown = JSON.parse(
    await getExecutor().runFileAsync('xcrun', ['simctl', 'list', '-j'], { timeoutMs: SIMCTL_TIMEOUT_MS, signal }),
  );
  if (!isJsonObject(listed) || !isJsonObject(listed.devices) || !Array.isArray(listed.runtimes))
    throw new Error('simctl list returned no devices or runtimes');
  const runtimeId = Object.entries(listed.devices).find(
    ([, devices]) => Array.isArray(devices) && devices.some((device) => isJsonObject(device) && device.udid === udid),
  )?.[0];
  const runtime = listed.runtimes.find((entry) => isJsonObject(entry) && entry.identifier === runtimeId);
  if (!isJsonObject(runtime) || typeof runtime.buildversion !== 'string' || typeof runtime.runtimeRoot !== 'string')
    throw new Error(`no installed runtime for ${udid}`);
  return { build: runtime.buildversion, root: runtime.runtimeRoot };
}

async function readRuntimePlists(root: string, signal: AbortSignal): Promise<unknown[]> {
  const files = ['LaunchDaemons', 'LaunchAgents'].flatMap((dir) => {
    const path = join(root, 'System', 'Library', dir);
    try {
      return readdirSync(path)
        .filter((name) => name.endsWith('.plist'))
        .map((name) => join(path, name));
    } catch {
      return [];
    }
  });
  const plists: unknown[] = [];
  let next = 0;
  const worker = async () => {
    for (let file = files[next++]; file !== undefined && !signal.aborted; file = files[next++]) {
      try {
        plists.push(
          JSON.parse(
            await getExecutor().runFileAsync('plutil', ['-convert', 'json', '-o', '-', file], {
              timeoutMs: PLUTIL_TIMEOUT_MS,
              signal,
            }),
          ),
        );
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: PLUTIL_PARALLEL }, worker));
  signal.throwIfAborted();
  if (plists.length === 0) throw new Error(`no launchd plist could be read under ${root}`);
  return plists;
}

/**
 * The cached build under `key`, or a new one under `signal`. A shared build started by another caller that rejects
 * while this caller's own signal is live (that caller was aborted) is rebuilt once under this caller's signal.
 */
export async function sharedBuild<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  build: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const start = (): Promise<T> => {
    const promise = build(signal);
    cache.set(key, promise);
    promise.catch(() => {
      if (cache.get(key) === promise) cache.delete(key);
    });
    return promise;
  };
  const shared = cache.get(key);
  if (!shared) return start();
  try {
    return await shared;
  } catch (error) {
    if (signal.aborted) throw error;
    const current = cache.get(key);
    return current && current !== shared ? current : start();
  }
}

async function slimServiceMap(udid: string, signal: AbortSignal): Promise<Map<string, string>> {
  const runtime = await runtimeOf(udid, signal);
  return sharedBuild(
    serviceMaps,
    runtime.build,
    async (buildSignal) => machServiceLabels(await readRuntimePlists(runtime.root, buildSignal), SIM_SLIM_MANAGED),
    signal,
  );
}

function holdPending(pending: LaunchdEvent[], event: LaunchdEvent): void {
  if (pending.length >= PENDING_LIMIT) {
    const oldestLookup = pending.findIndex((held) => held.kind === 'lookup');
    if (event.kind === 'lookup' && oldestLookup === -1) return;
    pending.splice(Math.max(oldestLookup, 0), 1);
  }
  pending.push(event);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Follows the host launchd.log of an owned, slimmed simulator from its current end, and writes a slim_service_denied
 * record (warn for a listed feature, debug otherwise) when the app asks for a service slimming turned off. Starts
 * nothing for any other simulator, and never throws: a failure stops the reader with one line to `stderr`.
 */
export function watchSlimDenials({
  udid,
  bundleId,
  executable,
  signal,
  write,
  stderr,
}: {
  udid: string;
  bundleId: string;
  executable: string;
  signal: AbortSignal;
  write: (record: NdjsonRecord) => void;
  stderr: (line: string) => void;
}): void {
  let disabled: Set<string>;
  let path: string;
  try {
    if (signal.aborted || !readCreatedDevices().ios.has(udid)) return;
    disabled = storedSlimLabels(udid);
    path = launchdLogPath(udid);
  } catch {
    return;
  }
  if (disabled.size === 0) return;
  const position = (() => {
    try {
      const stat = statSync(path);
      return { ino: stat.ino, offset: stat.size };
    } catch {
      return { ino: -1, offset: 0 };
    }
  })();
  let partial = '';
  let filter: ((event: LaunchdEvent) => SlimDenial | null) | null = null;
  let stopped = false;
  let failures = 0;
  const pending: LaunchdEvent[] = [];
  const stop = (error?: unknown) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    pending.length = 0;
    if (error === undefined || signal.aborted) return;
    try {
      stderr(`slim service report off for ${udid}: ${describe(error)}`);
    } catch {}
  };
  const report = (event: LaunchdEvent) => {
    if (stopped) return;
    const denial = filter?.(event);
    if (!denial) return;
    const { msg, ...fields } = denial;
    write({ src: 'device', event: 'slim_service_denied', ...fields, msg });
  };
  const readNew = () => {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      const next = nextLogOffset(position, stat);
      if (next.restarted) partial = '';
      position.ino = stat.ino;
      position.offset = next.offset;
      const length = Math.min(stat.size - position.offset, READ_LIMIT);
      if (length <= 0) return;
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, position.offset);
      position.offset += read;
      const lines = (partial + buffer.subarray(0, read).toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseLaunchdLine(line);
        if (!event) continue;
        if (filter) report(event);
        else holdPending(pending, event);
      }
    } finally {
      closeSync(fd);
    }
  };
  const poll = () => {
    if (stopped) return;
    try {
      readNew();
      failures = 0;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      if (++failures >= POLL_FAILURE_LIMIT) stop(error);
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  signal.addEventListener('abort', () => stop(), { once: true });
  slimServiceMap(udid, signal)
    .then((services) => {
      if (stopped) return undefined;
      filter = createSlimDenialFilter({ bundleId, executable, disabled, services });
      for (const event of pending.splice(0)) report(event);
      return undefined;
    })
    .catch(stop);
}
