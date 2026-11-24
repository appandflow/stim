import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isJsonObject,
  readHelperRestarts,
  readDaemonSnapshot,
  type AppleServicesStatus,
  type HelperState,
} from '@stim-cli/core/state';
import { CliUsageError } from './cli/define-op.ts';
import { getExecutor } from './exec.ts';
import type { HostProcess } from './devices/activity.ts';

const PATHS = [
  '/usr/libexec/PerfPowerServices',
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mds_stores',
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared',
  '/System/Library/PrivateFrameworks/PhotoAnalysis.framework/Versions/A/Support/photoanalysisd',
  '/System/Library/PrivateFrameworks/MediaAnalysis.framework/Versions/A/mediaanalysisd',
];

function hostExecutable(): string | undefined {
  return [join(homedir(), 'Applications', 'Stim Host.app'), '/Applications/Stim Host.app']
    .map((app) => join(app, 'Contents', 'MacOS', 'stim-host'))
    .find(existsSync);
}

export async function helperCommand(action: 'register' | 'unregister' | 'status'): Promise<HelperState> {
  if (process.platform !== 'darwin') {
    if (action === 'status') return 'unavailable on this OS';
    throw new CliUsageError(
      'The runaway service helper requires macOS. Run `stim service install --helper` or `stim service uninstall --helper` on a Mac with Stim Host installed.',
    );
  }
  const executable = hostExecutable();
  if (!executable) {
    if (action === 'status') return 'not registered';
    throw new CliUsageError(
      'Install a current Developer ID-signed, notarized Stim Host.app in ~/Applications or /Applications, then retry this command.',
    );
  }
  try {
    const value: unknown = JSON.parse(
      await getExecutor().runFileAsync(executable, [`helper-${action}`], {
        timeoutMs: action === 'status' ? 2000 : 30_000,
      }),
    );
    const state = isJsonObject(value) ? value.state : undefined;
    if (
      state === 'registered' ||
      state === 'requires approval' ||
      state === 'not registered' ||
      state === 'unavailable on this OS'
    )
      return state;
    throw new Error('Stim Host returned no helper state');
  } catch (error) {
    throw new CliUsageError(
      `Could not ${action} the helper: ${error instanceof Error ? error.message : error}. Install a helper-capable Developer ID-signed, notarized Stim Host and retry; approve it in System Settings > General > Login Items & Extensions.`,
    );
  }
}

export async function helperStatus(): Promise<HelperState> {
  try {
    return await helperCommand('status');
  } catch {
    return 'unavailable on this OS';
  }
}

// @ref LLP 0001#opt-in-apple-service-restarts -- stimd reports these processes and never signals them
export function appleServicesStatus(
  processes: readonly HostProcess[],
  helper: HelperState,
  now: number = Date.now(),
): AppleServicesStatus {
  return {
    helper,
    warnings:
      helper === 'registered'
        ? []
        : processes.flatMap((row) => {
            const path = row.command.split(/\s/, 1)[0] ?? '';
            if (!PATHS.includes(path) || (row.cpuPercent <= 150 && row.rssKb <= 2 * 1024 ** 2)) return [];
            const name = path.slice(path.lastIndexOf('/') + 1);
            return [
              {
                name,
                pid: row.pid,
                cpu: row.cpuPercent,
                rss: row.rssKb * 1024,
                commands: [`sudo killall -TERM ${name}`, 'stim service install --helper'],
              },
            ];
          }),
    restarts: helper === 'registered' ? readHelperRestarts(now) : [],
  };
}

export function appleServicesLines(status?: AppleServicesStatus): string[] {
  if (!status) return [];
  return [
    ...status.warnings.map(
      (row) =>
        `Apple service ${row.name} (pid ${row.pid}): ${Math.round(row.cpu)}% CPU, ${(row.rss / 1024 ** 3).toFixed(1)} GB RSS; one-off restart: \`${row.commands[0]}\`; enable automatic restarts: \`${row.commands[1]}\``,
    ),
    ...status.restarts.map(
      (row) =>
        `Apple service: restarted ${row.name} at ${new Date(row.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${Math.round(row.cpu)}% CPU, ${(row.rss / 1024 ** 3).toFixed(1)} GB RSS for ${Math.floor(row.seconds / 60)} min)`,
    ),
  ];
}

export async function readAppleServicesStatus(
  processes: () => readonly HostProcess[] | null | Promise<HostProcess[] | null>,
  sample: boolean,
): Promise<AppleServicesStatus | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const helper = await helperStatus();
  if (sample) return appleServicesStatus((await processes()) ?? [], helper);
  const snapshot = readDaemonSnapshot();
  const fresh = snapshot && Date.now() - Date.parse(snapshot.tickAt) <= 10 * 60_000;
  return {
    helper,
    warnings: helper === 'registered' ? [] : (fresh && snapshot.measurement.appleServices?.warnings) || [],
    restarts: helper === 'registered' ? readHelperRestarts() : [],
  };
}
