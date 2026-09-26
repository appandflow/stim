import { join } from 'node:path';
import type { DeviceAppProcess } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import type { DeviceProcessTables } from './activity.ts';

interface AppProcessTarget {
  platform: 'ios' | 'android';
  id: string;
  appId: string;
}

const bundleIdsByApp = new Map<string, string>();

function simAppPaths(commands: readonly string[], udid: string): string[] {
  const marker = `/Devices/${udid}/data/Containers/Bundle/Application/`;
  const paths = new Set<string>();
  for (const command of commands) {
    const at = command.indexOf(marker);
    if (!command.startsWith('/') || at < 0 || /\s\//.test(command.slice(0, at))) continue;
    const rest = command.slice(at + marker.length);
    const app = /^[^/]+\/[^/]+\.app\//.exec(rest)?.[0];
    if (!app || /^[^/\s]*\//.test(rest.slice(app.length))) continue;
    paths.add(command.slice(0, at + marker.length) + app.slice(0, -1));
  }
  return [...paths];
}

function androidAppRunning(psOutput: string, packageName: string): boolean {
  return psOutput.split('\n').some((line) => {
    const match = /^\s*\d+\s+(\S+)\s*$/.exec(line);
    return match?.[1] === packageName;
  });
}

function plistBundleId(appPath: string): string | null {
  const cached = bundleIdsByApp.get(appPath);
  if (cached) return cached;
  const value = getExecutor().runFileQuiet(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appPath, 'Info.plist')],
    { timeoutMs: 2000 },
  );
  const id = value?.trim() || null;
  if (id) bundleIdsByApp.set(appPath, id);
  return id;
}

export function createAppProcessReader(
  tables: DeviceProcessTables,
  bundleIdOf: (appPath: string) => string | null = plistBundleId,
): (target: AppProcessTarget) => DeviceAppProcess {
  return ({ platform, id, appId }) => {
    const result = (state: DeviceAppProcess['state']): DeviceAppProcess => ({ id: appId, state });
    if (platform === 'android') {
      const output = tables.android(id);
      if (output === null) return result('unknown');
      return result(androidAppRunning(output, appId) ? 'running' : 'stopped');
    }
    const host = tables.host();
    if (host === null) return result('unknown');
    const ids = simAppPaths(
      host.map((row) => row.command),
      id,
    ).map(bundleIdOf);
    if (ids.includes(appId)) return result('running');
    return result(ids.includes(null) ? 'unknown' : 'stopped');
  };
}
