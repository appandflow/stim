import { cancellableSleep } from '../cancellation.ts';
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

const POLL_MS = 250;

function failure(code: string, message: string, remedy: string | null): { ok: false; error: WebFailure } {
  return { ok: false, error: { code, message, remedy } };
}

export function browserWebProject(root: string): WebProject {
  return {
    runtime: ({ settings, headed, note }) => ({
      async prepare() {
        const web = webSettings(settings);
        const usesMetro = web.url === null || web.url.includes('{port:metro}');
        const pin = usesMetro ? metroPortSetting(settings) : null;
        if (pin?.error) return failure('STIM_BAD_ARG', pin.error, SETTING_SHAPE_REMEDY);

        const chrome = findChrome();
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
        const startedAt = Date.now();
        let measured: WebLaunchVerdict | null;
        for (;;) {
          measured = webLaunchVerdict({
            records: readNdjsonGenerations(webLogFile(root)),
            metroRecords: expectBundle ? readMetroRecords(workspaceLogsDir(root)) : [],
            since,
            expectBundle,
            elapsedMs: Date.now() - startedAt,
          });
          if (measured) break;
          await cancellableSleep(POLL_MS);
        }
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
