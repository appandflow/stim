import chalk from 'chalk';
import type { Command } from 'commander';
import type { WebBrowserState } from '@stim-cli/core/state';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { workspaceLinkLine, workspaceLinks } from '../devices/stim-desktop.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { WebFailure } from '../integrations/web-project.ts';
import type { WebLaunched } from '../web/launch.ts';
import { liveWebRecord } from '../web/page.ts';
import { cdpEndpoint, readWebRecord } from '../web/state.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { findCommandWorkspace } from '../workspace/project.ts';
import { resolveSettings, SETTING_SHAPE_REMEDY, settingShapeErrors } from '../workspace/settings.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { ensureWorkspaceStorageSafely } from './native-runtime.ts';

export interface WebFacts extends WebBrowserState {
  platform: 'web';
  reused: boolean;
  launched: WebLaunched;
  metroPort: number | null;
  logs: { dir: string };
  durationMs: number;
}

const printNote = (line: string) => console.error(line);

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
  if (shapeError)
    return { ok: false, error: { code: 'STIM_BAD_ARG', message: shapeError, remedy: SETTING_SHAPE_REMEDY } };
  const selected = projectRegistry.selectWeb(root);
  if ('problem' in selected) {
    const { message, remedy } = selected.problem;
    return { ok: false, error: { code: 'STIM_NO_PROJECT', message, remedy } };
  }
  const project = await selected.load();
  const runtime = project.runtime({ settings, headed, note });
  const preparation = await runtime.prepare();
  if (!preparation.ok) return { ok: false, error: { ...preparation.error, remedy: preparation.error.remedy ?? null } };
  const { prepared } = preparation;
  const { url } = prepared;
  const launch = await runtime.launch(prepared, { root, note });
  if (!launch.ok) return launch;

  const { verdict, remedy } = await runtime.verify(prepared, { since: launch.since });
  const live = liveWebRecord(readWebRecord(root));
  const record = live ?? launch.record;
  return {
    ok: true,
    remedy,
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
      targetId: live?.targetId ?? null,
      reused: launch.reused,
      launched: verdict.launched,
      metroPort: prepared.metroPort,
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
      const links = workspaceLinks(root, { platform: 'web' });
      if (json) {
        console.log(JSON.stringify(links ? { ...facts, links } : facts));
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
      if (links) console.error(chalk.dim(workspaceLinkLine(links)));
    });
}
