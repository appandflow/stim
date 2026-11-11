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
const PLUTIL_PARALLEL = 8;
const SIMCTL_TIMEOUT_MS = 30_000;
const PLUTIL_TIMEOUT_MS = 10_000;

export type LaunchdEvent =
  | { kind: 'lookup'; service: string; proc: string; pid: number }
  | { kind: 'spawn'; bundleId: string; pid: number };

/** One line of a simulator's launchd.log: a failed Mach lookup (error 3, no such process) or an app's spawn. */
export function parseLaunchdLine(line: string): LaunchdEvent | null {
  const lookup =
    /failed lookup: name = (?<service>[^,\s]+),.*?\brequestor = (?<proc>.+?)\[(?<pid>\d+)\], error = 3:/.exec(
      line,
    )?.groups;
  if (lookup?.service && lookup.proc)
    return { kind: 'lookup', service: lookup.service, proc: lookup.proc, pid: Number(lookup.pid) };
  const spawn = /\(\S*UIKitApplication:(?<bundleId>[^[\s]+)\[[^)]*\) <\w+>: \S+ spawned with pid (?<pid>\d+)\s*$/.exec(
    line,
  )?.groups;
  if (spawn?.bundleId) return { kind: 'spawn', bundleId: spawn.bundleId, pid: Number(spawn.pid) };
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
 * `bundleId`; before one is seen, its executable name) asking for a service of a label in `disabled`, once per
 * feature (or label) per launch.
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
  let appPid: number | null = null;
  const reported = new Set<string>();
  return (event) => {
    if (event.kind === 'spawn') {
      if (event.bundleId === bundleId && event.pid !== appPid) {
        appPid = event.pid;
        reported.clear();
      }
      return null;
    }
    if (appPid === null ? event.proc !== name : event.pid !== appPid) return null;
    const label = services.get(event.service);
    if (label === undefined || !disabled.has(label)) return null;
    const features = SIM_SLIM_FEATURES.filter((feature) => feature.labels.includes(label));
    const category = SIM_SLIM_CATEGORIES.find((entry) => entry.labels.includes(label)) ?? null;
    const key = `${event.pid}\0${features.length > 0 ? features.map((feature) => feature.id).join(',') : label}`;
    if (reported.has(key)) return null;
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

async function runtimeOf(udid: string): Promise<{ build: string; root: string }> {
  const listed: unknown = JSON.parse(
    await getExecutor().runFileAsync('xcrun', ['simctl', 'list', '-j'], {
      timeoutMs: SIMCTL_TIMEOUT_MS,
    }),
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

async function readRuntimePlists(root: string): Promise<unknown[]> {
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
    for (let file = files[next++]; file !== undefined; file = files[next++]) {
      try {
        plists.push(
          JSON.parse(
            await getExecutor().runFileAsync('plutil', ['-convert', 'json', '-o', '-', file], {
              timeoutMs: PLUTIL_TIMEOUT_MS,
            }),
          ),
        );
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: PLUTIL_PARALLEL }, worker));
  if (plists.length === 0) throw new Error(`no launchd plist could be read under ${root}`);
  return plists;
}

async function slimServiceMap(udid: string): Promise<Map<string, string>> {
  const runtime = await runtimeOf(udid);
  let map = serviceMaps.get(runtime.build);
  if (!map) {
    map = readRuntimePlists(runtime.root).then((plists) => machServiceLabels(plists, SIM_SLIM_MANAGED));
    serviceMaps.set(runtime.build, map);
    map.catch(() => serviceMaps.delete(runtime.build));
  }
  return map;
}

/**
 * Follows the host launchd.log of an owned, slimmed simulator from its current end, and writes a warn record when
 * the app asks for a service slimming turned off. Starts nothing for any other simulator.
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
  if (signal.aborted || !readCreatedDevices().ios.has(udid)) return;
  let disabled: Set<string>;
  try {
    disabled = storedSlimLabels(udid);
  } catch {
    return;
  }
  if (disabled.size === 0) return;
  const path = launchdLogPath(udid);
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
  const pending: LaunchdEvent[] = [];
  const report = (event: LaunchdEvent) => {
    if (signal.aborted) return;
    const denial = filter?.(event);
    if (!denial) return;
    const { msg, ...fields } = denial;
    write({ src: 'device', event: 'slim_service_denied', ...fields, msg });
  };
  void slimServiceMap(udid).then(
    (services) => {
      if (signal.aborted) return undefined;
      filter = createSlimDenialFilter({
        bundleId,
        executable,
        disabled,
        services,
      });
      for (const event of pending.splice(0)) report(event);
      return undefined;
    },
    (error: unknown) => {
      clearInterval(timer);
      pending.length = 0;
      stderr(`slim service report off for ${udid}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  const poll = () => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
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
        else if (pending.length < PENDING_LIMIT) pending.push(event);
      }
    } finally {
      closeSync(fd);
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
