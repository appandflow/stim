import { ambientWrite, type StimContext } from '@stim-cli/core';
import {
  readMacosRecord,
  type HostedMacosPlacement,
  type HostedIosPlacement,
  type HostedAndroidPlacement,
} from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { readHostedIos, readHostedAndroid } from './ios-state.ts';
import { pullHostedNativeLogs, pullHostedMacosLogs } from './hosted-logs.ts';
import { connectHost, type HostConnection } from './hosted-macos.ts';

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
  }: {
    context?: ReadContext;
    platform?: 'ios' | 'android';
    failing?: boolean;
    intervalMs?: number;
    retryMs?: number;
    slot?: string;
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
      if (slot !== undefined)
        await pullHostedNativeLogs(
          root,
          slot,
          placement as HostedIosPlacement | HostedAndroidPlacement,
          host,
          false,
          platform,
          signal,
        );
      else await pullHostedMacosLogs(root, placement, host, undefined, undefined, false, signal);
      failing = false;
    } catch (error) {
      host?.connection.close();
      host = undefined;
      if (signal.aborted) return;
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

export async function syncHostedLogs(root: string, context?: ReadContext): Promise<boolean> {
  const macos = readMacosRecord(root)?.host;
  const warnings = new Set<string>();
  const results = await Promise.all([
    ...(macos ? [syncHostedMacosLogs(root, macos, undefined, warnings, 'ios', context)] : []),
    ...Object.entries(readHostedIos(root)).map(([slot, placement]) =>
      syncHostedMacosLogs(root, placement, slot, warnings, 'ios', context),
    ),
    ...Object.entries(readHostedAndroid(root)).map(([slot, placement]) =>
      syncHostedMacosLogs(root, placement, slot, warnings, 'android', context),
    ),
  ]);
  return results.every(Boolean);
}

export function followHostedLogs(root: string, failing: boolean, context?: ReadContext): () => void {
  const stops = new Map<string, () => void>();
  const refresh = () => {
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
  refresh();
  const timer = setInterval(refresh, 500);
  return () => {
    clearInterval(timer);
    for (const stop of stops.values()) stop();
  };
}
