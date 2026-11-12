import { readMacosRecord, stimdClaimRoot, type MacosAppRecord, type MacosProcess } from '@stim-cli/core/state';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  startedNotBefore,
  waitForProcessExit,
} from '../process-identity.ts';
import { getExecutor } from '../exec.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { withWorkspaceStateLockAsync, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { hostedBundleDirs, runningBundleInstancesAsync, runningInstancesInAsync, startedBy } from './instances.ts';
import {
  macosAppStderr,
  macosAppStdout,
  macosAppStopRequest,
  macosRuntimeClaim,
  requiredMacosRecord,
} from './state.ts';
import { drained } from '../stimd/logs/macos-tail.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { drainOwnedMacos } from '../daemon/client.ts';
import { processGroupAlive, readClaimSet } from '../ownership-claim.ts';
import type { StimContext } from '@stim-cli/core';

const APP_EXIT_MS = 5000;
const SUPERVISOR_EXIT_MS: number = 2 * APP_EXIT_MS + 2000;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopProcesses(
  records: readonly MacosProcess[],
  waitMs: number = APP_EXIT_MS,
  operation?: StimContext,
): Promise<void> {
  let live = [...new Map(records.map((record) => [record.pid, record])).values()];
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    operation?.signal.throwIfAborted();
    live = live.filter((record) => {
      const identity = inspectProcessIdentity(record);
      if (identity === 'gone' || identity === 'different') return false;
      if (identity !== 'same') {
        throw Object.assign(new Error(`Cannot verify macOS owner pid ${record.pid}; no signal was sent.`), {
          code: 'STIM_MACOS_OWNER_UNVERIFIED',
        });
      }
      return true;
    });
    for (const record of live) {
      operation?.signal.throwIfAborted();
      signal(record.pid, name);
    }
    const exited = await Promise.all(live.map((record) => waitForProcessExit(record, waitMs, operation?.signal)));
    live = live.filter((_, index) => !exited[index]);
    if (!live.length) return;
  }
  throw new Error(`Owned macOS process ${live.map((record) => record.pid).join(', ')} did not exit.`);
}

export async function stopMacosChildren(owner: Pick<MacosProcess, 'pid' | 'processToken'>): Promise<void> {
  if (inspectProcessIdentity(owner) !== 'same')
    throw new Error('Cannot verify the macOS app before draining its children.');
  const children = await startedBy([owner], undefined, true);
  if (inspectProcessIdentity(owner) !== 'same')
    throw new Error('The macOS app exited while its children were inspected.');
  await stopProcesses(children);
}

/** Stops every running copy of the workspace's owned app bundle, including copies LaunchServices started. */
export async function stopBundleInstances(root: string, operation?: StimContext): Promise<boolean> {
  const instances = await runningBundleInstancesAsync(root, operation);
  await stopProcesses(instances, undefined, operation);
  return instances.length > 0;
}

/** Stops every running copy of a hosted session's app bundles, including copies LaunchServices started from an earlier attempt. */
export async function stopHostedBundleInstances(area: string, operation?: StimContext): Promise<void> {
  await stopProcesses(await runningInstancesInAsync(hostedBundleDirs(area), operation), undefined, operation);
}

/** Records that Stim ends the live app it launched as `launchId`, before it signals it. */
export function requestMacosStop(root: string, launchId: string): void {
  const file = macosAppStopRequest(root, launchId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, '', { mode: 0o600 });
}

async function groupGone(pgid: number, waitMs: number): Promise<boolean> {
  for (const deadline = Date.now() + waitMs; processGroupAlive(pgid);) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function groupMembers(pgid: number, operation?: StimContext): Promise<number[]> {
  const listed = await runOperationFile(operation, getExecutor(), 'ps', ['-axo', 'pid=,pgid='], {
    cwd: operation?.cwd,
    timeoutMs: 10_000,
    killSignal: 'SIGKILL',
  });
  return listed
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((match) => match !== null && Number(match[2]) === pgid)
    .map((match) => Number(match?.[1]));
}

function signalLaunchGroup(app: MacosProcess, members: readonly number[], name: NodeJS.Signals): boolean {
  if (inspectProcessIdentity(app) !== 'gone' || !processGroupAlive(app.pid)) return false;
  for (const pid of members) {
    const captured = captureProcessIdentity(pid);
    if (!captured.ok) {
      if (captured.reason.startsWith('NOT_FOUND')) continue;
      return false;
    }
    if (pid === process.pid || !startedNotBefore({ pid, processToken: captured.token }, app)) return false;
  }
  process.kill(-app.pid, name);
  return true;
}

// @ref LLP 0017#the-launch-group -- a requested end stops only the group Stim created for the launch
async function stopLaunchGroup(
  root: string,
  record: MacosAppRecord,
  app: MacosProcess,
  operation?: StimContext,
): Promise<void> {
  if (process.platform === 'win32' || !processGroupAlive(app.pid)) return;
  if (
    record.supervisor?.pid === app.pid &&
    app.pid !== process.pid &&
    inspectProcessIdentity(app) === 'gone' &&
    !drained(workspaceLogsDir(root), app)
  )
    for (const name of ['SIGTERM', 'SIGKILL'] as const) {
      const members = await groupMembers(app.pid, operation);
      try {
        if (!signalLaunchGroup(app, members, name)) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      if (await groupGone(app.pid, APP_EXIT_MS)) return;
    }
  if (!processGroupAlive(app.pid)) return;
  throw Object.assign(
    new Error(
      `The macOS app leader exited but process group ${app.pid} remains and could not be verified as this launch's group; no signal was sent to it. Inspect it with ps -A -o pid,pgid,command and stop its verified owned members before retrying.`,
    ),
    {
      code: 'STIM_MACOS_OWNER_UNVERIFIED',
      remedy: 'Verify the remaining group members belong to this workspace before stopping them.',
    },
  );
}

export async function stopMacosAppHeld(root: string, operation?: StimContext): Promise<boolean> {
  operation?.signal.throwIfAborted();
  const record = requiredMacosRecord(root);
  const requested =
    record?.app && !record.host && inspectProcessIdentity(record.app) === 'same' ? record.launchId : null;
  if (requested) requestMacosStop(root, requested);
  try {
    return await stopMacosAppRecorded(root, record, operation);
  } catch (error) {
    if (requested && record?.app && inspectProcessIdentity(record.app) === 'same')
      rmSync(macosAppStopRequest(root, requested), { force: true });
    throw error;
  }
}

async function stopMacosAppRecorded(
  root: string,
  record: MacosAppRecord | null,
  operation?: StimContext,
): Promise<boolean> {
  const started = await startedBy(
    [record?.supervisor, record?.app].filter((each) => each !== undefined),
    operation,
  );
  if (record?.supervisor && record.supervisor.pid !== record.app?.pid)
    await stopProcesses([record.supervisor], SUPERVISOR_EXIT_MS, operation);
  const app = readMacosRecord(root)?.app ?? record?.app;
  if (app) await stopProcesses([app], undefined, operation);
  await stopProcesses(started, undefined, operation);
  const instances = await runningBundleInstancesAsync(root, operation);
  await stopProcesses(instances, undefined, operation);
  operation?.signal.throwIfAborted();
  if (!record) return instances.length > 0;
  if (app) await stopLaunchGroup(root, record, app, operation);
  const claims = readClaimSet(macosRuntimeClaim(root));
  if (claims.unresolved.length || claims.live.length) {
    throw Object.assign(
      new Error('The macOS runtime claim cannot be released; inspect its recorded owner before cleanup.'),
      {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
      },
    );
  }
  return true;
}

/** Stops the workspace's app here, or its session on the hosting Mac, which must confirm the session stopped. */
export function stopMacosApp(
  root: string,
  operation?: StimContext,
  options: { drain?: boolean } = {},
): Promise<boolean> {
  const stop = async () => {
    operation?.signal.throwIfAborted();
    const record = requiredMacosRecord(root);
    if (!record?.host) {
      const stopped = await stopMacosAppHeld(root, operation);
      if (options.drain !== false) await drainMacosOutput(root, record, operation);
      return stopped;
    }
    const { stopHostedMacos } = await import('../device-host/hosted-macos.ts');
    await stopHostedMacos(root, record.host, operation?.signal);
    operation?.signal.throwIfAborted();
    const { host: _host, hostLaunched: _launched, ...stopped } = record;
    await withWorkspaceStateLockAsync(
      root,
      () => writeWorkspaceState(root, { macos: { ...stopped, supervisor: undefined } }),
      operation?.signal,
    );
    return true;
  };
  return withWorkspaceProcessLock(workspaceDir(root), 'macos-launch', stop, {
    external: true,
    waitMs: 0,
    ownerPurpose: 'stop macOS app',
    signal: operation?.signal,
    declareSpawnsFor: operation,
  });
}

export async function drainMacosOutput(
  root: string,
  record: MacosAppRecord | null,
  operation?: StimContext,
  env: NodeJS.ProcessEnv | undefined = operation?.env,
): Promise<void> {
  if (!record?.app || record.supervisor?.pid !== record.app.pid) return;
  const claims = readClaimSet(stimdClaimRoot());
  if (
    claims.live.length ||
    claims.unresolved.length ||
    existsSync(macosAppStdout(root, record.launchId)) ||
    existsSync(macosAppStderr(root, record.launchId))
  ) {
    const failure = await drainOwnedMacos(root, env);
    operation?.signal.throwIfAborted();
    if (failure !== null)
      throw Object.assign(new Error(`Could not drain macOS app output: ${failure}`), {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
        remedy:
          'Stop the process that still holds the app output, verify the app has exited, then run the command again.',
      });
  }
}
