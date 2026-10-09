import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import { BROWSER_LOCK, teardownBrowserHeld } from '../devices/teardown.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
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
import { sleep } from '../commands/native-runtime.ts';
import { liveWebRecord, sendToOwnedPage } from './page.ts';
import { readWebRecord, updateWebRecord, webSupervisorLogFile, type WebLaunchConfig, type WebRecord } from './state.ts';

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
      env: { ...process.env, ...launcher.env },
      windowsHide: true,
    });
  }
  const fd = openSync(logFile, 'a');
  const child = getExecutor().spawn(process.execPath, [entry, ...args], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref?.();
  return child;
}

async function waitForSupervisor(root: string, child: ChildProcess, launchId: string): Promise<WebRecord | null> {
  let exited = false;
  if (process.platform !== 'win32') {
    child.once('exit', () => {
      exited = true;
    });
  }
  const deadline = Date.now() + REGISTER_WAIT_MS;
  while (Date.now() < deadline) {
    const record = readWebRecord(root);
    if (record?.launchId === launchId && record.targetId) return record;
    if (exited) return null;
    await sleep(POLL_MS);
  }
  return null;
}

export async function launchOwnedBrowser(
  { url, config }: Pick<WebRuntimePreparation, 'url' | 'config'>,
  { root, note }: WebRuntimeContext,
): Promise<WebLaunchResult> {
  return withWorkspaceProcessLock(
    workspaceDir(root),
    BROWSER_LOCK,
    async (): Promise<
      { ok: true; record: WebRecord; since: number; reused: boolean } | { ok: false; error: WebFailure }
    > => {
      const live = liveWebRecord(readWebRecord(root));
      if (live && sameLaunch(live, config)) {
        const since = Date.now();
        try {
          await sendToOwnedPage(live, 'Page.navigate', { url });
          updateWebRecord(root, live, { url });
          note(chalk.dim(phaseLine('device', `reusing the owned Chrome (pid ${live.chromeProcess?.pid})`)));
          return { ok: true, record: { ...live, url }, since, reused: true };
        } catch (error) {
          note(chalk.dim(phaseLine('device', `restarting the owned Chrome: ${(error as Error).message}`)));
        }
      }
      const stopped = await teardownBrowserHeld(root);
      if (stopped.status === 'failed' || stopped.status === 'skipped') {
        return failure(
          'STIM_WEB_BROWSER_HELD',
          `The previous owned Chrome could not be stopped: ${stopped.reason ?? 'unknown reason'}.`,
          'Run `stim status` and `stim guide errors teardown`.',
        );
      }
      const port = await reserveBrowserPort(root);
      const since = Date.now();
      note(
        chalk.dim(phaseLine('device', `starting ${config.headless ? 'headless ' : ''}Chrome on DevTools port ${port}`)),
      );
      const launchId = randomUUID();
      const child = startSupervisor(root, { url, port, config, launchId });
      const record = await waitForSupervisor(root, child, launchId);
      if (!record) {
        return failure(
          'STIM_WEB_LAUNCH_FAILED',
          'The owned Chrome did not start.',
          `Read ${webSupervisorLogFile(root)} and \`stim logs --errors\`, then run \`stim web\` again.`,
        );
      }
      return { ok: true, record, since, reused: false };
    },
    { external: true, ownerPurpose: 'stim web' },
  );
}
