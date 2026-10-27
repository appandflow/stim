import { watch, type FSWatcher } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { ambientWrite, configDir, type StimContext } from '@stim-cli/core';
import {
  readMacosRecord,
  workspaceStateFile,
  type HostedMacosPlacement,
  type HostedIosPlacement,
  type HostedAndroidPlacement,
} from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { readHostedIos, readHostedAndroid } from './ios-state.ts';
import { pullHostedNativeLogs, pullHostedMacosLogs, readHostedNativeLogs } from './hosted-logs.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { connectHost, type HostConnection } from './hosted-macos.ts';

const WATCH_RECHECK_MS = 100;

type ReadContext = Pick<StimContext, 'signal' | 'output'>;

function warn(context: ReadContext | undefined, machine: string, error: unknown): void {
  const text = `${warning(machine, error)}\n`;
  if (context) context.output('stderr', text);
  else ambientWrite('stderr', text);
}

function warning(machine: string, error: unknown): string {
  const message = (error as Error).message.replace(/\.$/, '');
  const hint = message.includes('refused device-host.logs.query')
    ? ` If ${machine} runs an older stim-server, update it.`
    : '';
  return phaseLine(
    'device',
    `Could not read the app's logs from ${machine}: ${message}. Showing the logs already copied here.${hint}`,
  );
}

export async function syncHostedMacosLogs(
  root: string,
  placement: HostedMacosPlacement | HostedIosPlacement | HostedAndroidPlacement,
  slot?: string,
  warnings?: Set<string>,
  platform: 'ios' | 'android' = 'ios',
  context?: ReadContext,
): Promise<boolean> {
  let host: HostConnection | undefined;
  const cancel = () => host?.connection.close();
  context?.signal.addEventListener('abort', cancel, { once: true });
  try {
    host = await connectHost(placement.machine, undefined, false, context?.signal);
    if (slot !== undefined)
      await pullHostedNativeLogs(
        root,
        slot,
        placement as HostedIosPlacement | HostedAndroidPlacement,
        host,
        false,
        platform,
        context?.signal,
      );
    else await pullHostedMacosLogs(root, placement, host, undefined, undefined, false, context?.signal);
    return true;
  } catch (error) {
    context?.signal.throwIfAborted();
    if (!warnings?.has(placement.machine)) {
      warn(context, placement.machine, error);
      warnings?.add(placement.machine);
    }
    return false;
  } finally {
    context?.signal.removeEventListener('abort', cancel);
    host?.connection.close();
  }
}

export function followHostedMacosLogs(
  root: string,
  {
    failing = false,
    intervalMs = 500,
    retryMs = 5000,
    slot,
    platform = 'ios',
    context,
    onPulled,
    onFailed,
  }: {
    context?: ReadContext;
    platform?: 'ios' | 'android';
    failing?: boolean;
    intervalMs?: number;
    retryMs?: number;
    slot?: string;
    onPulled?: (through: number | undefined) => void;
    onFailed?: () => void;
  } = {},
): () => void {
  let host: HostConnection | undefined;
  const controller = new AbortController();
  const signal = context ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  const cancel = () => host?.connection.close();
  signal.addEventListener('abort', cancel, { once: true });
  let retryAt = 0;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped || signal.aborted || Date.now() < retryAt) return;
    running = true;
    try {
      const placement =
        slot !== undefined
          ? (platform === 'ios' ? readHostedIos(root) : readHostedAndroid(root))[slot]
          : readMacosRecord(root)?.host;
      if (!placement) {
        host?.connection.close();
        host = undefined;
        return;
      }
      host ??= await connectHost(placement.machine, undefined, false, signal);
      const through =
        slot !== undefined
          ? await pullHostedNativeLogs(
              root,
              slot,
              placement as HostedIosPlacement | HostedAndroidPlacement,
              host,
              false,
              platform,
              signal,
            )
          : await pullHostedMacosLogs(root, placement, host, undefined, undefined, false, signal);
      failing = false;
      onPulled?.(through);
    } catch (error) {
      host?.connection.close();
      host = undefined;
      if (signal.aborted) return;
      onFailed?.();
      if (!failing)
        warn(
          context,
          (slot !== undefined
            ? (platform === 'ios' ? readHostedIos(root) : readHostedAndroid(root))[slot]
            : readMacosRecord(root)?.host
          )?.machine ?? 'the host',
          error,
        );
      failing = true;
      retryAt = Date.now() + retryMs;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    controller.abort();
    signal.removeEventListener('abort', cancel);
    clearInterval(timer);
    host?.connection.close();
  };
}

export interface HostedLaunchLogs {
  readDeviceRecords: () => NdjsonRecord[];
  readNativeCrashes: () => NdjsonRecord[];
  deviceLogsThrough: () => number | null;
  stop: () => void;
}

/** Copies a hosted slot's native logs while its launch is verified; a failed copy stops holding the launch windows. */
export function followHostedLaunchLogs(
  root: string,
  slot: string,
  platform: 'ios' | 'android',
  since: number,
  context?: ReadContext,
): HostedLaunchLogs {
  let through: number | null = null;
  let failed = false;
  const stop = followHostedMacosLogs(root, {
    slot,
    platform,
    context,
    onPulled: (covered) => {
      failed = false;
      if (covered !== undefined) through = Math.max(through ?? covered, covered);
    },
    onFailed: () => {
      failed = true;
    },
  });
  const records = () => readHostedNativeLogs(root, platform, slot);
  return {
    readDeviceRecords: records,
    readNativeCrashes: () =>
      records().filter((record) => record.event === 'native_crash' && Number(record.ts) >= since),
    deviceLogsThrough: () => (failed ? Number.POSITIVE_INFINITY : through),
    stop,
  };
}

export async function syncHostedLogs(root: string, context?: ReadContext, includeSlots = true): Promise<boolean> {
  const macos = readMacosRecord(root)?.host;
  const warnings = new Set<string>();
  const results = await Promise.all([
    ...(macos ? [syncHostedMacosLogs(root, macos, undefined, warnings, 'ios', context)] : []),
    ...(includeSlots
      ? [
          ...Object.entries(readHostedIos(root)).map(([slot, placement]) =>
            syncHostedMacosLogs(root, placement, slot, warnings, 'ios', context),
          ),
          ...Object.entries(readHostedAndroid(root)).map(([slot, placement]) =>
            syncHostedMacosLogs(root, placement, slot, warnings, 'android', context),
          ),
        ]
      : []),
  ]);
  return results.every(Boolean);
}

export function followHostedLogs(root: string, failing: boolean, context?: ReadContext): () => void {
  const stops = new Map<string, () => void>();
  let closed = false;
  const refresh = () => {
    if (closed) return;
    const active = new Set<string>();
    if (readMacosRecord(root)?.host) {
      active.add('macos');
      if (!stops.has('macos')) stops.set('macos', followHostedMacosLogs(root, { failing, context }));
    }
    for (const platform of ['ios', 'android'] as const)
      for (const slot of Object.keys(platform === 'ios' ? readHostedIos(root) : readHostedAndroid(root))) {
        const key = `${platform}:${slot}`;
        active.add(key);
        if (!stops.has(key)) stops.set(key, followHostedMacosLogs(root, { failing, slot, platform, context }));
      }
    for (const [key, stop] of stops) {
      if (active.has(key)) continue;
      stop();
      stops.delete(key);
    }
  };
  const stateFile = workspaceStateFile(root);
  const home = resolve(configDir());
  let watcher: FSWatcher | null = null;
  let recheck: NodeJS.Timeout | undefined;
  const observe = () => {
    if (closed) return;
    watcher?.close();
    watcher = null;
    clearTimeout(recheck);
    let directory = dirname(stateFile);
    for (;;) {
      try {
        const entry = relative(directory, stateFile).split(sep)[0];
        const next = watch(directory, (_event, name) => {
          if (name !== null && name.toString() !== entry) return;
          if (directory !== dirname(stateFile)) observe();
          refresh();
        });
        next.on('error', () => {
          next.close();
          if (watcher === next) watcher = null;
        });
        next.unref();
        watcher = next;
        // Node fs.watch on macOS can drop events for changes made just after watch() returns:
        // https://github.com/nodejs/node/issues/52601
        recheck = setTimeout(refresh, WATCH_RECHECK_MS);
        recheck.unref();
        return;
      } catch (error) {
        if (directory === home || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return;
        directory = dirname(directory);
      }
    }
  };
  observe();
  refresh();
  const timer = setInterval(() => {
    observe();
    refresh();
  }, 10_000);
  return () => {
    closed = true;
    watcher?.close();
    clearTimeout(recheck);
    clearInterval(timer);
    for (const stop of stops.values()) stop();
  };
}
