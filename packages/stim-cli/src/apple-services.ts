import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isJsonObject,
  readHelperRestarts,
  readHelperHeartbeat,
  helperHealthy,
  type HelperHeartbeat,
  readDaemonSnapshot,
  type AppleServicesStatus,
  type HelperState,
} from '@stim-cli/core/state';
import { CliUsageError } from './cli/define-op.ts';
import { getExecutor, isTimeoutError } from './exec.ts';
import { loadServerCli } from './server-cli.ts';
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
  if (action !== 'status') helperCache = undefined;
  if (process.platform !== 'darwin') {
    if (action === 'status') return 'unavailable on this OS';
    throw new CliUsageError(
      'The runaway service helper requires macOS. Run `stim service install --helper` or `stim service uninstall --helper` on a Mac with Stim Host installed.',
    );
  }
  let executable: string | undefined;
  if (action === 'register') {
    try {
      executable = (await (await loadServerCli()).installHostApp()).executable;
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
  } else executable = hostExecutable();
  if (!executable) {
    if (action === 'status') return 'Stim Host missing';
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
    if (action === 'status') {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 64)
        return 'Stim Host too old';
      return isTimeoutError(error) ? 'status timed out' : 'status error';
    }
    throw new CliUsageError(
      `Could not ${action} the helper: ${error instanceof Error ? error.message : error}. ${action === 'register' ? 'Retry' : 'Run `stim service install --helper` to update Stim Host, then retry'}; approve Stim Host in System Settings > General > Login Items & Extensions.`,
    );
  }
}

let helperCache: { executable: string | undefined; at: number; state: Promise<HelperState> } | undefined;

export async function helperStatus(): Promise<HelperState> {
  if (process.platform !== 'darwin') return 'unavailable on this OS';
  const executable = hostExecutable();
  if (!helperCache || helperCache.executable !== executable || Date.now() - helperCache.at >= 300_000) {
    helperCache = { executable, at: Date.now(), state: helperCommand('status') };
  } else if ((await helperCache.state) === 'registered' && !helperHealthy(readHelperHeartbeat())) {
    helperCache = { executable, at: Date.now(), state: helperCommand('status') };
  }
  return helperCache.state;
}

// @ref LLP 0001#opt-in-apple-service-restarts -- stimd reports these processes and never signals them
export function appleServicesStatus(
  processes: readonly HostProcess[],
  helper: HelperState,
  now: number = Date.now(),
  heartbeat: HelperHeartbeat | undefined = readHelperHeartbeat(),
): AppleServicesStatus {
  return {
    helper,
    ...(heartbeat ? { heartbeat } : {}),
    warnings:
      helper === 'registered' && helperHealthy(heartbeat, now)
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
                commands: ['stim service install --helper'],
              },
            ];
          }),
    restarts: helper === 'registered' ? readHelperRestarts(now) : [],
  };
}

function helperHealthLine(status: AppleServicesStatus): string | undefined {
  return status.helper === 'registered' && !helperHealthy(status.heartbeat)
    ? `Runaway service helper: registered but not running/healthy (${status.heartbeat?.error ?? (status.heartbeat ? 'stale heartbeat' : 'missing heartbeat')}); see /Library/Logs/Stim/helper.err and helper.heartbeat`
    : undefined;
}

export function appleServicesLines(status?: AppleServicesStatus): string[] {
  if (!status) return [];
  const health = helperHealthLine(status);
  return [
    ...(health ? [health] : []),
    ...status.warnings.map(
      (row) =>
        `Apple service ${row.name} (pid ${row.pid}): ${Math.round(row.cpu)}% CPU, ${(row.rss / 1024 ** 3).toFixed(1)} GB RSS; enable automatic restarts: \`${row.commands[0]}\``,
    ),
    ...status.restarts.map(
      (row) =>
        `Apple service: restarted ${row.name} at ${new Date(row.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${Math.round(row.cpu)}% CPU, ${(row.rss / 1024 ** 3).toFixed(1)} GB RSS for ${Math.floor(row.seconds / 60)} min)`,
    ),
  ];
}

export async function readAppleServicesStatus(): Promise<AppleServicesStatus | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const helper = await helperStatus();
  const heartbeat = readHelperHeartbeat();
  const snapshot = readDaemonSnapshot();
  const fresh = snapshot && Date.now() - Date.parse(snapshot.tickAt) <= 10 * 60_000;
  return {
    helper,
    ...(heartbeat ? { heartbeat } : {}),
    warnings:
      helper === 'registered' && helperHealthy(heartbeat)
        ? []
        : (fresh && snapshot.measurement.appleServices?.warnings) || [],
    restarts: helper === 'registered' ? readHelperRestarts() : [],
  };
}

export function createAppleServicesObserver(): (status: AppleServicesStatus) => {
  status: AppleServicesStatus;
  lines: string[];
} {
  let previous = new Set<string>();
  let logged = new Map<string, string>();
  let healthLine: string | undefined;
  const restarts = new Map<string, number>();
  return (sample) => {
    const current = new Map(
      sample.warnings.map((row) => [
        `${row.name}:${row.pid}`,
        `${row.cpu > 150}:${row.rss > 2 * 1024 ** 3}:${sample.helper}:${helperHealthy(sample.heartbeat)}:${sample.heartbeat?.error ?? ''}`,
      ]),
    );
    const warnings = sample.warnings.filter((row) => previous.has(`${row.name}:${row.pid}`));
    const status = { ...sample, warnings };
    const changed = warnings.filter(
      (row) => logged.get(`${row.name}:${row.pid}`) !== current.get(`${row.name}:${row.pid}`),
    );
    const fresh = sample.restarts.filter((row) => !restarts.has(`${row.name}:${row.pid}:${row.at}`));
    for (const row of sample.restarts) restarts.set(`${row.name}:${row.pid}:${row.at}`, row.at);
    for (const [key, at] of restarts) if (at < Date.now() - 3600_000) restarts.delete(key);
    previous = new Set(current.keys());
    logged = new Map(warnings.map((row) => [`${row.name}:${row.pid}`, current.get(`${row.name}:${row.pid}`) ?? '']));
    const lines = appleServicesLines({ ...status, warnings: changed, restarts: fresh }).filter(
      (line) => line !== healthLine,
    );
    healthLine = helperHealthLine(status);
    return { status, lines };
  };
}
