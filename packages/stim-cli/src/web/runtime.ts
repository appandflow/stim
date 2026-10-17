import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import { BROWSER_LOCK, teardownBrowserHeld } from '../devices/teardown.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { withWorkspaceProcessLock, WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import type {
  WebFailure,
  WebLaunchResult,
  WebRuntimeContext,
  WebRuntimePreparation,
} from '../integrations/web-project.ts';
import { reserveBrowserPort } from '../named-ports.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { clearClaimChild, markClaimChildPending, setClaimChild } from '../ownership-claim.ts';
import { captureProcessIdentity } from '../process-identity.ts';
import { liveWebRecord, sendToOwnedPage } from './page.ts';
import { readWebRecord, updateWebRecord, webSupervisorLogFile, type WebLaunchConfig, type WebRecord } from './state.ts';
import { ambientEnv } from '@stim-cli/core';

const REGISTER_WAIT_MS = 30_000;
const POLL_MS = 250;

function failure(code: string, message: string, remedy: string | null): { ok: false; error: WebFailure } {
  return { ok: false, error: { code, message, remedy } };
}

function sameLaunch(record: WebRecord, config: WebLaunchConfig): boolean {
  return (
    record.chrome === config.chrome &&
    record.headless === config.headless &&
    record.viewport === config.viewport &&
    record.ignoreCertificateErrors === config.ignoreCertificateErrors
  );
}

function startSupervisor(
  root: string,
  { url, port, config, launchId }: { url: string; port: number; config: WebLaunchConfig; launchId: string },
): ChildProcess {
  const entry = spawnEntry('web-run');
  const args = [
    '--root',
    root,
    '--chrome',
    config.chrome,
    '--url',
    url,
    '--port',
    String(port),
    '--launch-id',
    launchId,
  ];
  if (!config.headless) args.push('--headed');
  if (config.viewport !== 'desktop') args.push('--viewport', config.viewport);
  if (config.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  const logFile = webSupervisorLogFile(root);
  if (process.platform === 'win32') {
    const launcher = windowsLauncherArgs({ entry, args, cwd: root, logFile });
    return getExecutor().spawn(launcher.file, launcher.args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...ambientEnv(), ...launcher.env },
      windowsHide: true,
    });
  }
  const fd = openSync(logFile, 'a');
  const child = getExecutor().spawn(process.execPath, [entry, ...args], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd, 'ipc'],
    env: ambientEnv(),
  });
  child.unref?.();
  return child;
}

function waitForSupervisor(
  root: string,
  child: ChildProcess,
  launchId: string,
  signal?: AbortSignal,
): Promise<WebRecord | null> {
  const deadline = Date.now() + REGISTER_WAIT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let repairTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (record: WebRecord | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(repairTimer);
      clearTimeout(deadlineTimer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onExit);
      child.removeListener('disconnect', check);
      signal?.removeEventListener('abort', check);
      if (child.connected) child.disconnect();
      resolve(record);
    };
    const check = () => {
      if (settled) return;
      if (Date.now() >= deadline) return finish(null);
      const record = readWebRecord(root);
      if (record?.launchId === launchId && (record.targetId || signal?.aborted)) return finish(record);
      if (process.platform !== 'win32' && (child.exitCode !== null || child.signalCode !== null)) finish(null);
    };
    const onExit = () => {
      check();
      finish(null);
    };
    const onMessage = (message: unknown) => {
      if (message === 'web-registered') check();
    };
    const repair = () => {
      check();
      if (!settled) repairTimer = setTimeout(repair, process.platform === 'win32' ? POLL_MS : 1000);
    };
    const deadlineTimer = setTimeout(() => finish(null), REGISTER_WAIT_MS);
    child.on('message', onMessage);
    if (process.platform !== 'win32') child.once('exit', onExit);
    child.once('error', onExit);
    child.once('disconnect', check);
    signal?.addEventListener('abort', check);
    check();
    if (!settled) repairTimer = setTimeout(repair, process.platform === 'win32' ? POLL_MS : 1000);
  });
}

export async function launchOwnedBrowser(
  { url, config }: Pick<WebRuntimePreparation, 'url' | 'config'>,
  { root, note, signal }: WebRuntimeContext,
): Promise<WebLaunchResult> {
  return withWorkspaceProcessLock(
    workspaceDir(root),
    BROWSER_LOCK,
    async (
      claim,
    ): Promise<{ ok: true; record: WebRecord; since: number; reused: boolean } | { ok: false; error: WebFailure }> => {
      throwIfCancelled(signal, 'browser launch');
      const live = liveWebRecord(readWebRecord(root));
      if (live && sameLaunch(live, config)) {
        const since = Date.now();
        try {
          await sendToOwnedPage(live, 'Page.navigate', { url }, signal);
          updateWebRecord(root, live, { url });
          note(chalk.dim(phaseLine('device', `reusing the owned Chrome (pid ${live.chromeProcess?.pid})`)));
          return { ok: true, record: { ...live, url }, since, reused: true };
        } catch (error) {
          throwIfCancelled(signal, 'browser launch');
          note(chalk.dim(phaseLine('device', `restarting the owned Chrome: ${(error as Error).message}`)));
        }
      }
      throwIfCancelled(signal, 'browser launch');
      const stopped = await teardownBrowserHeld(root);
      if (stopped.status === 'failed' || stopped.status === 'skipped') {
        return failure(
          'STIM_WEB_BROWSER_HELD',
          `The previous owned Chrome could not be stopped: ${stopped.reason ?? 'unknown reason'}.`,
          'Run `stim status` and `stim guide errors teardown`.',
        );
      }
      throwIfCancelled(signal, 'browser launch');
      const port = await reserveBrowserPort(root);
      const since = Date.now();
      note(
        chalk.dim(phaseLine('device', `starting ${config.headless ? 'headless ' : ''}Chrome on DevTools port ${port}`)),
      );
      const launchId = randomUUID();
      throwIfCancelled(signal, 'browser launch');
      markClaimChildPending(claim);
      let child: ChildProcess;
      try {
        child = startSupervisor(root, { url, port, config, launchId });
      } catch (error) {
        clearClaimChild(claim);
        throw error;
      }
      const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
      if (captured?.ok) {
        try {
          setClaimChild(claim, { pid: child.pid, processToken: captured.token });
        } catch {
          throw new WorkspaceProcessCleanupError(
            [claim],
            'The browser supervisor could not be recorded.',
            'Run `stim stop`.',
          );
        }
      }
      const record = await waitForSupervisor(root, child, launchId, signal);
      if (signal?.aborted) {
        const cleanup = record ? await teardownBrowserHeld(root) : null;
        if (!cleanup || cleanup.status === 'failed' || cleanup.status === 'skipped') {
          throw new WorkspaceProcessCleanupError(
            [claim],
            'The cancelled browser launch could not be stopped.',
            'Run `stim stop`.',
          );
        }
        clearClaimChild(claim);
        throwIfCancelled(signal, 'browser launch');
      }
      if (!record) {
        return failure(
          'STIM_WEB_LAUNCH_FAILED',
          'The owned Chrome did not start.',
          `Read ${webSupervisorLogFile(root)} and \`stim logs --errors\`, then run \`stim web\` again.`,
        );
      }
      return { ok: true, record, since, reused: false };
    },
    { external: true, ownerPurpose: 'stim web', signal },
  );
}
