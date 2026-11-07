import { withWorkspaceStateLockAsync } from '../workspace/workspace-state.ts';
import { mkdirSync } from 'node:fs';
import chalk from 'chalk';
import { ambientEnv } from '@stim-cli/core';
import { phaseLine } from '../command-output.ts';
import { observeOwned } from '../daemon/client.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { BROWSER_LOCK, teardownBrowserHeld } from '../devices/teardown.ts';
import { spawnOwned } from '../engine/spawn-owned.ts';
import { withWorkspaceProcessLock, WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import type {
  WebFailure,
  WebLaunchResult,
  WebRuntimeContext,
  WebRuntimePreparation,
} from '../integrations/web-project.ts';
import { signalProcessTree } from '../metro.ts';
import { reserveBrowserPort } from '../named-ports.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { chromeArgs } from './chrome.ts';
import { liveWebRecord, sendToOwnedPage } from './page.ts';
import { removeSingletonFiles } from './profile.ts';
import {
  browserLogFile,
  readWebRecord,
  updateWebRecord,
  webClaimRoot,
  webProfileDir,
  writeWebRecord,
  type WebLaunchConfig,
  type WebRecord,
} from './state.ts';

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
          const unobserved = await observeOwned(root, ambientEnv());
          if (unobserved) throw new Error(unobserved);
          await sendToOwnedPage(live, 'Page.navigate', { url }, signal);
          await withWorkspaceStateLockAsync(root, () => updateWebRecord(root, live, { url }));
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
      throwIfCancelled(signal, 'browser launch');
      const profile = webProfileDir(root);
      mkdirSync(profile, { recursive: true });
      recordCreatedDevice('web', profile);
      removeSingletonFiles(profile);
      const launch = {
        chrome: config.chrome,
        headless: config.headless,
        viewport: config.viewport,
        ignoreCertificateErrors: config.ignoreCertificateErrors,
      };
      const chrome = spawnOwned({
        file: config.chrome,
        args: chromeArgs({ profile, port, ...launch }),
        cwd: root,
        env: ambientEnv(),
        stdout: browserLogFile(root),
        stderr: browserLogFile(root),
        claim: { root: webClaimRoot(root), label: 'owned Chrome' },
        declare: [claim],
      });
      const owner = { pid: chrome.pid, processToken: chrome.processToken };
      try {
        await withWorkspaceStateLockAsync(root, () =>
          writeWebRecord(root, {
            ...owner,
            ...launch,
            chromeProcess: owner,
            cdpPort: port,
            profile,
            url,
            startedAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        try {
          signalProcessTree(chrome.pid, 'SIGKILL', { group: true });
        } catch {}
        throw error;
      }
      const unobserved = await observeOwned(root, ambientEnv());
      const record = liveWebRecord(readWebRecord(root));
      if (signal?.aborted || unobserved !== null || !record || record.chromeProcess?.pid !== chrome.pid) {
        const cleanup = await teardownBrowserHeld(root);
        if (cleanup.status === 'failed' || cleanup.status === 'skipped') {
          throw new WorkspaceProcessCleanupError(
            [claim],
            `The ${signal?.aborted ? 'cancelled' : 'failed'} browser launch could not be stopped: ${cleanup.reason ?? 'unknown reason'}.`,
            'Run `stim stop`.',
          );
        }
        throwIfCancelled(signal, 'browser launch');
        return failure(
          'STIM_WEB_LAUNCH_FAILED',
          `The owned Chrome did not start: ${unobserved ?? 'its page was not observed'}.`,
          `Read ${browserLogFile(root)} and \`stim logs --errors\`, then run \`stim web\` again.`,
        );
      }
      await sendToOwnedPage(record, 'Page.navigate', { url }, signal);
      return { ok: true, record, since, reused: false };
    },
    { external: true, ownerPurpose: 'stim web', signal },
  );
}
