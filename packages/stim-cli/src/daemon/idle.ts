import { statSync } from 'node:fs';
import { join } from 'node:path';
import { collectOwnedDeviceActivity, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { runStop } from '../commands/stop.ts';
import { workspaceDeviceLastUseAt } from '../devices/activity.ts';
import { dueIdleDevices, shutDownIdleDevices, writeIdleShutdownEvent } from '../devices/idle-shutdown.ts';
import { listAllIosSims, type IosSimRecord } from '../devices/ios.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { decideIdleStop, idleStopEvidence } from '../maintenance/idle-stop.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { loadConfig, type ProjectRecord } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import {
  deviceIdleShutdownMinutesSetting,
  metroIdleStopMinutesSetting,
  resolveProjectSettings,
} from '../workspace/settings.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { daemonOwnsSupervisedIdle } from './client.ts';

const MINUTE_MS = 60_000;
const SIM_LIST_TIMEOUT_MS = 10_000;

export function listSims(): IosSimRecord[] {
  try {
    return listAllIosSims({ timeoutMs: SIM_LIST_TIMEOUT_MS });
  } catch {
    return [];
  }
}

function clientLogAt(root: string): number {
  try {
    return statSync(join(workspaceLogsDir(root), 'client.ndjson')).mtimeMs;
  } catch {
    return NaN;
  }
}

function bootedDevices(path: string, project: ProjectRecord, now: number): OwnedDeviceActivity[] {
  const config = loadConfig();
  if (!config) return [];
  return collectOwnedDeviceActivity({ ...config, projects: { [path]: project } }, listSims(), now);
}

async function decideTogether(path: string, project: ProjectRecord, idleMs: number, locked: boolean) {
  const now = Date.now();
  const evidence = await idleStopEvidence(path, bootedDevices(path, project, now), {
    now,
    idleMs,
    locked,
    serving: true,
  });
  const clientLog = clientLogAt(path);
  if (Number.isFinite(clientLog)) evidence.activity.push({ basis: 'client log', at: clientLog });
  return decideIdleStop(evidence, { idleMs, now });
}

/**
 * Stops a supervised workspace's dev server and its owned devices in one `stim stop` once the workspace has had no
 * activity, of either, for the smaller of metro.idleStopMinutes and devices.idleShutdownMinutes.
 */
async function stopTogether(path: string, project: ProjectRecord, minutes: number, log: (line: string) => void) {
  const idleMs = minutes * MINUTE_MS;
  if (Date.now() - workspaceDeviceLastUseAt(path) < idleMs) return;
  const first = await decideTogether(path, project, idleMs, false);
  if (!first.stop) return;
  const run = await withIdleWorkspace(
    path,
    async () => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async () => {
            const again = await decideTogether(path, project, idleMs, true);
            if (!again.stop) return `kept: ${again.reason}`;
            const idleMinutes = Math.floor(again.idleMs / MINUTE_MS);
            const stopped = await runStop({
              root: path,
              report: () => {},
              requester: { by: `stim daemon (no activity for ${idleMinutes} minutes)` },
              releaseLeases: () => [],
            });
            return stopped.summary;
          },
          { external: true, waitMs: 0, ownerPurpose: 'idle stop' },
        );
      } catch (error) {
        if (workspaceProcessLockError(error)) return 'kept: a stim start holds its metro-start lock';
        throw error;
      }
    },
    { purpose: 'daemon idle stop', devServer: false, hosted: false, hostedMacos: false },
  );
  log(`${path}: ${run.ran ? run.value : `kept: ${run.reasons.join('; ')}`}`);
}

async function shutDownUnsupervised(path: string, minutes: number, now: number, log: (line: string) => void) {
  const idleMs = minutes * MINUTE_MS;
  if (!dueIdleDevices(path, idleMs, now).length) return;
  const run = await withIdleWorkspace(
    path,
    () =>
      shutDownIdleDevices(path, idleMs, (event) => {
        writeIdleShutdownEvent(path, event);
        log(`${path}: ${event.msg}`);
      }),
    { purpose: 'daemon device idle shutdown' },
  );
  if (!run.ran) log(`${path}: kept its idle devices: ${run.reasons.join('; ')}`);
}

/** One pass of the home's idle timers over every registered workspace. */
export async function runIdlePass(log: (line: string) => void, now: number = Date.now()): Promise<void> {
  for (const [path, project] of Object.entries(loadConfig()?.projects ?? {})) {
    try {
      const state = readWorkspaceState(path);
      const supervisor = resolveSupervisorTarget({
        state: state?.supervisor,
        record: project.supervisor,
        reservedPort: project.metroPort,
      });
      if (supervisor.status === 'unverified') continue;
      const settings = resolveProjectSettings(path).settings;
      const metroMinutes = metroIdleStopMinutesSetting(settings);
      const deviceMinutes = deviceIdleShutdownMinutesSetting(settings);
      if (supervisor.status === 'ours') {
        const record = state?.supervisor;
        if (
          daemonOwnsSupervisedIdle({
            mode: record?.mode,
            hmrUpdates: record?.hmrUpdates,
            idleStopMinutes: metroMinutes,
            deviceIdleMinutes: deviceMinutes,
          })
        )
          await stopTogether(path, project, Math.min(metroMinutes, deviceMinutes), log);
      } else if (deviceMinutes > 0) {
        await shutDownUnsupervised(path, deviceMinutes, now, log);
      }
    } catch (error) {
      log(`${path}: idle check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
