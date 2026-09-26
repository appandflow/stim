import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { WebBrowserState } from '@stim-cli/core/state';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { BROWSER_LOCK, teardownBrowserHeld } from '../devices/teardown.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { readMetroRecords } from '../engine/launch-verify.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';
import { getNamedPort, reserveBrowserPort } from '../named-ports.ts';
import { readNdjsonGenerations } from '../ndjson.ts';
import { reserveMetroPort } from '../ports.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { findChrome, CHROME_INSTALL_REMEDY } from '../web/chrome.ts';
import { webLaunchRemedy, webLaunchVerdict, type WebLaunched } from '../web/launch.ts';
import { liveWebRecord, sendToOwnedPage } from '../web/page.ts';
import {
  cdpEndpoint,
  readWebRecord,
  updateWebRecord,
  webLogFile,
  webSupervisorLogFile,
  type WebLaunchConfig,
  type WebRecord,
} from '../web/state.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { detectIsExpo, findCommandWorkspace, isPackageResolvable } from '../workspace/project.ts';
import { resolveSettings, SETTING_SHAPE_REMEDY, settingShapeErrors, webSettings } from '../workspace/settings.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { ensureWorkspaceStorageSafely, sleep } from './native-runtime.ts';

interface WebFailure {
  code: string;
  message: string;
  remedy: string | null;
}

export interface WebFacts extends WebBrowserState {
  platform: 'web';
  reused: boolean;
  launched: WebLaunched;
  metroPort: number | null;
  logs: { dir: string };
  durationMs: number;
}

const PORT_PLACEHOLDER = /\{port:([^}]*)\}/g;
const REGISTER_WAIT_MS = 30_000;
const POLL_MS = 250;

const printNote = (line: string) => console.error(line);

const EXPO_WEB_PACKAGES = ['react-dom', 'react-native-web', '@expo/metro-runtime'];
const EXPO_WEB_DEPENDENCIES = `npx expo install ${EXPO_WEB_PACKAGES.join(' ')}`;
const WEB_SERVER_EXAMPLE = 'pnpm exec vite --port "$(stim ports get web)" --strictPort';

function failure(code: string, message: string, remedy: string | null): { ok: false; error: WebFailure } {
  return { ok: false, error: { code, message, remedy } };
}

/** Replaces each `{port:<label>}` in a `web.url` template; `metro` is the workspace's Metro port. */
export async function resolveWebUrl(
  template: string,
  { metroPort, namedPort }: { metroPort: number | null; namedPort: (label: string) => Promise<number> },
): Promise<string> {
  let url = template;
  for (const [placeholder, label] of template.matchAll(PORT_PLACEHOLDER)) {
    const port = label === 'metro' ? metroPort : await namedPort(label!);
    if (port === null) throw new Error(`${placeholder} needs a Metro port, and this workspace has none reserved.`);
    url = url.replace(placeholder, String(port));
  }
  return url;
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

async function verifyLaunch(root: string, since: number, expectBundle: boolean) {
  const startedAt = Date.now();
  for (;;) {
    const verdict = webLaunchVerdict({
      records: readNdjsonGenerations(webLogFile(root)),
      metroRecords: expectBundle ? readMetroRecords(workspaceLogsDir(root)) : [],
      since,
      expectBundle,
      elapsedMs: Date.now() - startedAt,
    });
    if (verdict) return verdict;
    await sleep(POLL_MS);
  }
}

export async function runWeb({
  root,
  headed,
  note,
}: {
  root: string;
  headed: boolean;
  note: (line: string) => void;
}): Promise<{ ok: true; facts: WebFacts; remedy: string | null } | { ok: false; error: WebFailure }> {
  const startedAt = Date.now();
  await ensureWorkspaceStorageSafely(root, { note });
  if (!getProject(root)) upsertProject(root, {});
  const settings = resolveSettings({ projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) });
  const [shapeError] = settingShapeErrors(settings);
  if (shapeError) return failure('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY);
  const web = webSettings(settings);

  const chrome = findChrome();
  if (!chrome)
    return failure('STIM_WEB_NO_CHROME', 'Google Chrome or Chromium is not installed.', CHROME_INSTALL_REMEDY);

  const usesMetro = web.url === null || web.url.includes('{port:metro}');
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
  if (usesMetro && metroPort === null) metroPort = await reserveMetroPort(root);
  const expoWeb = usesMetro && detectIsExpo(root);
  const missingWebPackages = expoWeb ? EXPO_WEB_PACKAGES.filter((name) => !isPackageResolvable(root, name)) : [];
  let serve: string;
  if (!usesMetro) serve = `Start the web dev server on that port, for example \`${WEB_SERVER_EXAMPLE}\``;
  else if (missingWebPackages.length) serve = `Run \`${EXPO_WEB_DEPENDENCIES}\` and \`stim start\``;
  else serve = "Start this workspace's Metro with `stim start`";
  let url: string;
  try {
    url = await resolveWebUrl(web.url ?? 'http://localhost:{port:metro}/', {
      metroPort,
      namedPort: (label) => getNamedPort(root, label, { log: note }),
    });
  } catch (error) {
    return failure('STIM_BAD_ARG', `web.url: ${(error as Error).message}`, SETTING_SHAPE_REMEDY);
  }

  const config: WebLaunchConfig = {
    chrome,
    headless: !headed,
    viewport: web.viewport,
    ignoreCertificateErrors: web.ignoreCertificateErrors,
  };
  const launch = await withWorkspaceProcessLock(
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
      const port = await reserveBrowserPort(root, { log: note });
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
  if (!launch.ok) return launch;

  const verdict = await verifyLaunch(root, launch.since, usesMetro);
  const live = liveWebRecord(readWebRecord(root));
  const record = live ?? launch.record;
  const remedy = webLaunchRemedy(verdict, { url, template: web.url, usesMetro, serve });
  return {
    ok: true,
    remedy: verdict.reason && remedy ? `${verdict.reason}. ${remedy}` : remedy,
    facts: {
      platform: 'web',
      browser: 'chrome',
      version: record.version ?? null,
      running: live !== null,
      pid: live?.chromeProcess?.pid ?? null,
      supervisorPid: live?.pid ?? null,
      url,
      headless: record.headless,
      viewport: record.viewport,
      profile: record.profile,
      cdpEndpoint: live ? cdpEndpoint(live.cdpPort) : null,
      reused: launch.reused,
      launched: verdict.launched,
      metroPort: usesMetro ? metroPort : null,
      logs: { dir: workspaceLogsDir(root) },
      durationMs: Date.now() - startedAt,
    },
  };
}

export default function webCommand(program: Command): void {
  program
    .command('web')
    .description(
      "Open this workspace's page in a Stim-owned headless Chrome and capture its console, errors and failed requests in stim logs",
    )
    .option('--headed', 'Show the Chrome window instead of running headless')
    .option('--json', 'Print the result as one JSON object; progress goes to stderr')
    .action(async (opts: { headed?: boolean; json?: boolean }) => {
      const json = Boolean(opts.json);
      const root = findCommandWorkspace(process.cwd());
      if (!root) {
        refuseNoProject({ json });
        return;
      }
      recordWorkspaceUse(root);
      const result = await runWeb({ root, headed: Boolean(opts.headed), note: printNote });
      if (!result.ok) {
        printNote(chalk.red(phaseLine('error', `${result.error.code}: ${result.error.message}`)));
        if (result.error.remedy) printNote(phaseLine('remedy', result.error.remedy));
        if (json) console.log(JSON.stringify(result.error));
        process.exitCode = 1;
        return;
      }
      const { facts, remedy } = result;
      if (remedy) printNote(chalk.yellow(phaseLine('launch', remedy)));
      if (json) {
        console.log(JSON.stringify(facts));
        return;
      }
      const launched =
        facts.launched === true
          ? chalk.green('loaded')
          : chalk.yellow(facts.launched === 'bundling' ? 'bundling' : 'unverified');
      console.log(
        facts.running
          ? `${facts.url} ${launched} in ${facts.version ?? 'Chrome'} (pid ${facts.pid}, ${facts.headless ? 'headless' : 'headed'}, ${facts.viewport}). DevTools: ${facts.cdpEndpoint}. Logs: stim logs --errors.`
          : `${facts.url} ${launched}, and the owned Chrome is no longer running. Run stim logs --errors, then stim web again.`,
      );
    });
}
