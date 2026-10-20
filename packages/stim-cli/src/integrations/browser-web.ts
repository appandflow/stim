import { followLogs } from '@stim-cli/core/state';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { cancelledError } from '../cancellation.ts';
import { resolveWorkspaceMetroPort } from '../commands/start.ts';
import { readMetroRecords } from '../engine/launch-verify.ts';
import { resolveProjectMetro } from '../metro.ts';
import { getNamedPort } from '../named-ports.ts';
import { readNdjsonGenerations } from '../ndjson.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { findChrome, CHROME_INSTALL_REMEDY } from '../web/chrome.ts';
import {
  EXPO_WEB_DEPENDENCIES,
  EXPO_WEB_PACKAGES,
  LOADING_WAIT_MS,
  VERIFY_WAIT_MS,
  resolveWebUrl,
  webLaunchRemedy,
  webLaunchVerdict,
  webServePlan,
  type WebLaunchVerdict,
} from '../web/launch.ts';
import { launchOwnedBrowser } from '../web/runtime.ts';
import { webLogFile } from '../web/state.ts';
import { getProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { detectIsExpo, isPackageResolvable } from '../workspace/project-files.ts';
import { metroPortSetting, SETTING_SHAPE_REMEDY, webSettings } from '../workspace/settings.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import type { WebFailure, WebProject } from './web-project.ts';

async function verifyLaunch(root: string, since: number, expectBundle: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  let stop: (() => void) | undefined;
  let fileWatch: { watcher: FSWatcher; dev: number; ino: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: ReturnType<typeof setImmediate> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<WebLaunchVerdict>((resolve, reject) => {
      const schedule = () => {
        queued ??= setImmediate(check);
      };
      const watchFile = () => {
        try {
          const file = webLogFile(root);
          const stat = statSync(file);
          if (fileWatch?.dev === stat.dev && fileWatch.ino === stat.ino) return;
          fileWatch?.watcher.close();
          fileWatch = undefined;
          const watcher = watch(file, { persistent: false }, schedule);
          fileWatch = { watcher, dev: stat.dev, ino: stat.ino };
          const lost = () => {
            if (fileWatch?.watcher === watcher) fileWatch = undefined;
            watcher.close();
          };
          watcher.once('error', lost);
          watcher.once('close', lost);
        } catch {
          fileWatch?.watcher.close();
          fileWatch = undefined;
        }
      };
      const check = () => {
        clearImmediate(queued);
        queued = undefined;
        clearTimeout(timer);
        try {
          signal?.throwIfAborted();
          watchFile();
          const elapsedMs = Date.now() - startedAt;
          const measured = webLaunchVerdict({
            records: readNdjsonGenerations(webLogFile(root)),
            metroRecords: expectBundle ? readMetroRecords(workspaceLogsDir(root)) : [],
            since,
            expectBundle,
            elapsedMs,
          });
          if (measured) resolve(measured);
          else
            timer = setTimeout(
              check,
              Math.max(0, (elapsedMs < VERIFY_WAIT_MS ? VERIFY_WAIT_MS : LOADING_WAIT_MS) - elapsedMs),
            );
        } catch (error) {
          reject(error);
        }
      };
      stop = followLogs({
        dir: workspaceLogsDir(root),
        onRecord: schedule,
      });
      onAbort = () => reject(cancelledError('wait'));
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  } finally {
    stop?.();
    fileWatch?.watcher.close();
    clearTimeout(timer);
    clearImmediate(queued);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function failure(code: string, message: string, remedy: string | null): { ok: false; error: WebFailure } {
  return { ok: false, error: { code, message, remedy } };
}

export function browserWebProject(root: string): WebProject {
  return {
    runtime: ({ settings, headed, note, context }) => ({
      async prepare() {
        const web = webSettings(settings);
        const usesMetro = web.url === null || web.url.includes('{port:metro}');
        const pin = usesMetro ? metroPortSetting(settings, context?.env) : null;
        if (pin?.error) return failure('STIM_BAD_ARG', pin.error, SETTING_SHAPE_REMEDY);

        const chrome = findChrome({ env: context?.env });
        if (!chrome)
          return failure('STIM_WEB_NO_CHROME', 'Google Chrome or Chromium is not installed.', CHROME_INSTALL_REMEDY);

        if (web.url === null && !detectIsExpo(root)) {
          return failure(
            'STIM_WEB_NO_URL',
            'This is not an Expo app, so Stim does not know which page to open.',
            "Start your web dev server on a named port, then set the page: `stim settings set web.url 'http://localhost:{port:web}/' --scope workspace`. See `stim guide web`.",
          );
        }
        if (web.url === null && !isPackageResolvable(root, 'react-native-web')) {
          return failure(
            'STIM_WEB_DEPS_MISSING',
            'This Expo app cannot render on the web: react-native-web is not installed.',
            `Run \`${EXPO_WEB_DEPENDENCIES}\` and \`stim start\`, then run \`stim web\` again.`,
          );
        }

        let metroPort = getProject(root)?.metroPort ?? null;
        if (usesMetro && (pin?.port !== null || metroPort === null)) {
          const result = await resolveWorkspaceMetroPort(root, settings, note, 'web');
          if (typeof result !== 'number') return failure(result.code, result.message, result.remedy);
          metroPort = result;
        }
        const metro = usesMetro && metroPort !== null ? await resolveProjectMetro(metroPort, root) : null;
        const supervisor = resolveSupervisorTarget({
          state: readWorkspaceState(root)?.supervisor,
          record: getProject(root)?.supervisor,
          reservedPort: metroPort,
        });
        const { serve, foreign } = webServePlan({
          usesMetro,
          metro,
          supervisorHeld: supervisor.status !== 'none' && supervisor.status !== 'stale',
          missingWebPackages:
            usesMetro && detectIsExpo(root) ? EXPO_WEB_PACKAGES.filter((name) => !isPackageResolvable(root, name)) : [],
        });
        let url: string;
        try {
          url = await resolveWebUrl(web.url ?? 'http://localhost:{port:metro}/', {
            metroPort,
            namedPort: (label) => getNamedPort(root, label),
          });
        } catch (error) {
          return failure('STIM_BAD_ARG', `web.url: ${(error as Error).message}`, SETTING_SHAPE_REMEDY);
        }
        return {
          ok: true,
          prepared: {
            url,
            config: {
              chrome,
              headless: !headed,
              viewport: web.viewport,
              ignoreCertificateErrors: web.ignoreCertificateErrors,
            },
            metroPort: usesMetro ? metroPort : null,
            verification: { template: web.url, expectBundle: usesMetro, serve, foreign },
          },
        };
      },
      launch: launchOwnedBrowser,
      async verify({ url, verification: { template, expectBundle, serve, foreign } }, { since }) {
        const measured = await verifyLaunch(root, since, expectBundle, context?.signal);
        const verdict: WebLaunchVerdict = foreign
          ? { launched: 'unverified', kind: 'no-response', reason: foreign.reason }
          : measured;
        const remedy = foreign
          ? foreign.remedy
          : webLaunchRemedy(verdict, { url, template, usesMetro: expectBundle, serve });
        return { verdict, remedy: verdict.reason && remedy ? `${verdict.reason}. ${remedy}` : remedy };
      },
    }),
  };
}
