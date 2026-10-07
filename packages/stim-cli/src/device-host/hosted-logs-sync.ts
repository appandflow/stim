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
): Promise<boolean> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(placement.machine);
    if (slot !== undefined)
      await pullHostedNativeLogs(
        root,
        slot,
        placement as HostedIosPlacement | HostedAndroidPlacement,
        host,
        false,
        platform,
      );
    else await pullHostedMacosLogs(root, placement, host);
    return true;
  } catch (error) {
    if (!warnings?.has(placement.machine)) {
      process.stderr.write(`${warning(placement.machine, error)}\n`);
      warnings?.add(placement.machine);
    }
    return false;
  } finally {
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
  }: { platform?: 'ios' | 'android'; failing?: boolean; intervalMs?: number; retryMs?: number; slot?: string } = {},
): () => void {
  let host: HostConnection | undefined;
  let retryAt = 0;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped || Date.now() < retryAt) return;
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
      host ??= await connectHost(placement.machine);
      if (slot !== undefined)
        await pullHostedNativeLogs(
          root,
          slot,
          placement as HostedIosPlacement | HostedAndroidPlacement,
          host,
          false,
          platform,
        );
      else await pullHostedMacosLogs(root, placement, host);
      failing = false;
    } catch (error) {
      host?.connection.close();
      host = undefined;
      if (!failing)
        process.stderr.write(
          `${warning((slot !== undefined ? (platform === 'ios' ? readHostedIos(root) : readHostedAndroid(root))[slot] : readMacosRecord(root)?.host)?.machine ?? 'the host', error)}\n`,
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
    clearInterval(timer);
    host?.connection.close();
  };
}

export async function syncHostedLogs(root: string): Promise<boolean> {
  const macos = readMacosRecord(root)?.host;
  const warnings = new Set<string>();
  const results = await Promise.all([
    ...(macos ? [syncHostedMacosLogs(root, macos)] : []),
    ...Object.entries(readHostedIos(root)).map(([slot, placement]) =>
      syncHostedMacosLogs(root, placement, slot, warnings),
    ),
    ...Object.entries(readHostedAndroid(root)).map(([slot, placement]) =>
      syncHostedMacosLogs(root, placement, slot, warnings, 'android'),
    ),
  ]);
  return results.every(Boolean);
}

export function followHostedLogs(root: string, failing: boolean): () => void {
  const stops = new Map<string, () => void>();
  const refresh = () => {
    if (readMacosRecord(root)?.host && !stops.has('macos'))
      stops.set('macos', followHostedMacosLogs(root, { failing }));
    for (const platform of ['ios', 'android'] as const)
      for (const slot of Object.keys(platform === 'ios' ? readHostedIos(root) : readHostedAndroid(root))) {
        const key = `${platform}:${slot}`;
        if (!stops.has(key)) stops.set(key, followHostedMacosLogs(root, { failing, slot, platform }));
      }
  };
  refresh();
  const timer = setInterval(refresh, 500);
  return () => {
    clearInterval(timer);
    for (const stop of stops.values()) stop();
  };
}
