import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import type { Methods, WebShareRow } from '@stim-cli/core/protocol';
import {
  LocalServerUnavailable,
  requestLocalServer,
  type LocalServerAnswer,
  type ShareMethod,
} from '../local-server.ts';
import { findCommandWorkspaceAsync } from '../workspace/project.ts';
import { repoRootAsync } from '../workspace/worktree.ts';

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 480;
const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface ShareFailure {
  code: string;
  message: string;
  remedy: string | null;
}

type ShareRow = WebShareRow;

interface ShareOptions {
  slot?: string;
  device?: boolean;
  control?: boolean;
  expires?: string;
  json?: boolean;
}

export interface ShareDeps {
  findWorkspace: (cwd: string) => Promise<string | null>;
  request: <M extends ShareMethod>(method: M, params: Methods[M]['params']) => Promise<LocalServerAnswer<M>>;
}

const SERVER_REMEDY =
  'Web shares run inside stim-server. Open Stim Desktop, or install the background server with `stim-server service install`, then run stim share again.';

function failure(code: string, message: string, remedy: string | null): ShareFailure {
  return { code, message, remedy };
}

function report(error: ShareFailure, json: boolean): void {
  if (json) console.log(JSON.stringify(error));
  else {
    console.error(chalk.red(phaseLine('error', `${error.code}: ${error.message}`)));
    if (error.remedy) console.error(phaseLine('remedy', error.remedy));
  }
  process.exitCode = 1;
}

async function ask<M extends ShareMethod>(
  deps: ShareDeps,
  method: M,
  params: Methods[M]['params'],
): Promise<{ result: Methods[M]['result'] } | ShareFailure> {
  let answer: LocalServerAnswer<M>;
  try {
    answer = await deps.request(method, params);
  } catch (cause) {
    if (cause instanceof LocalServerUnavailable) {
      return failure(
        'STIM_SERVER_NOT_RUNNING',
        `No stim-server runs for this Stim home (${cause.message}).`,
        SERVER_REMEDY,
      );
    }
    return failure(
      'STIM_SHARE_REFUSED',
      cause instanceof Error ? cause.message : String(cause),
      'Check stim-server, then run stim share again.',
    );
  }
  if ('result' in answer) return answer;
  if (answer.error.code === 'unknown-method') {
    return failure(
      'STIM_SHARE_REFUSED',
      'The running stim-server does not serve web shares.',
      'Update stim-server to the version of this stim (`stim-server service update`), then run stim share again.',
    );
  }
  return failure(
    'STIM_SHARE_REFUSED',
    answer.error.message,
    'Fix what the message names, then run stim share again. `stim guide share` explains the requirements.',
  );
}

function parseMinutes(value: string | undefined): number | ShareFailure {
  if (value === undefined) return DEFAULT_MINUTES;
  const minutes = Number(value);
  if (!/^\d+$/.test(value) || minutes < 1 || minutes > MAX_MINUTES) {
    return failure(
      'STIM_BAD_ARG',
      `--expires ${JSON.stringify(value)} is not a number of minutes from 1 to ${MAX_MINUTES}.`,
      `Pass --expires <minutes>, such as --expires ${DEFAULT_MINUTES}. Every share expires; there is no "never".`,
    );
  }
  return minutes;
}

function describeRow(row: ShareRow): string {
  const target = `${row.platform}${row.physical ? ' device' : ''}${row.slot === 'default' ? '' : ` (slot ${row.slot})`}`;
  const mode = row.control ? 'view and control' : 'view only';
  return `${target} of ${row.workspace}: ${mode}, ${row.viewers} viewer${row.viewers === 1 ? '' : 's'}, expires ${row.expiresAt}`;
}

export async function runShare(
  action: string,
  opts: ShareOptions,
  deps: ShareDeps,
): Promise<{ ok: true; output: object; text: string } | { ok: false; error: ShareFailure }> {
  if (action === 'list') {
    const answer = await ask(deps, 'share.list', {});
    if ('code' in answer) return { ok: false, error: answer };
    const { shares } = answer.result;
    return {
      ok: true,
      output: { shares },
      text: shares.length ? shares.map(describeRow).join('\n') : 'No web shares are live.',
    };
  }
  const root = await deps.findWorkspace(process.cwd());
  if (!root) return { ok: false, error: failure('STIM_NO_PROJECT', '', null) };
  if (action === 'stop') {
    const answer = await ask(deps, 'share.stop', { workspace: root });
    if ('code' in answer) return { ok: false, error: answer };
    const { stopped } = answer.result;
    return {
      ok: true,
      output: { stopped },
      text: stopped.length
        ? `Stopped ${stopped.length} web share${stopped.length === 1 ? '' : 's'}; their links no longer work.`
        : 'This workspace has no live web share.',
    };
  }
  if (action !== 'ios' && action !== 'android') {
    return {
      ok: false,
      error: failure(
        'STIM_BAD_ARG',
        `Unknown share target ${JSON.stringify(action)}.`,
        'Use ios, android, stop or list.',
      ),
    };
  }
  if (opts.slot !== undefined && !SLOT.test(opts.slot)) {
    return {
      ok: false,
      error: failure(
        'STIM_BAD_ARG',
        `--slot ${JSON.stringify(opts.slot)} is not a slot name.`,
        'Use letters, digits, _ and -.',
      ),
    };
  }
  if (action === 'ios' && opts.device && opts.control) {
    return {
      ok: false,
      error: failure(
        'STIM_BAD_ARG',
        'A physical iPhone is view only: Stim shows its screen but sends it no input.',
        'Run stim share ios --device without --control.',
      ),
    };
  }
  const minutes = parseMinutes(opts.expires);
  if (typeof minutes !== 'number') return { ok: false, error: minutes };
  const answer = await ask(deps, 'share.start', {
    workspace: root,
    platform: action,
    ...(opts.slot && opts.slot !== 'default' ? { slot: opts.slot } : {}),
    ...(opts.device ? { physical: true } : {}),
    control: opts.control === true,
    expiresMinutes: minutes,
  });
  if ('code' in answer) return { ok: false, error: answer };
  const started = answer.result;
  return {
    ok: true,
    output: started,
    text: [
      `Shared ${describeRow(started)}.`,
      `URL:      ${started.url}`,
      `Password: ${started.password}`,
      'Anyone with both can open it from the internet until it expires. The password is shown only now.',
      'Stop it with: stim share stop',
    ].join('\n'),
  };
}

const DEFAULT_DEPS = (version: string): ShareDeps => ({
  findWorkspace: (cwd) => findCommandWorkspaceAsync(cwd, repoRootAsync, (line) => console.error(line)),
  request: (method, params) => requestLocalServer(method, params, { version }),
});

export function registerShare(program: Command, version: string, deps: Partial<ShareDeps> = {}): void {
  program
    .command('share <action>')
    .description(
      "Share this workspace's running app through a public, password-protected web link: share ios|android starts one, share stop ends this workspace's shares, share list lists live shares. Needs a running stim-server.",
    )
    .option('--slot <name>', 'Share the device of this slot')
    .option('--device', 'Share the physical device this workspace leases instead of its simulator or emulator')
    .option('--control', 'Let viewers tap, type and press buttons (watch only without it)')
    .option('--expires <minutes>', `Minutes until the share ends, 1 to ${MAX_MINUTES}`, String(DEFAULT_MINUTES))
    .option('--json', 'Emit one JSON payload')
    .action(async (action: string, opts: ShareOptions) => {
      const result = await runShare(action, opts, { ...DEFAULT_DEPS(version), ...deps });
      if (!result.ok) {
        if (result.error.code === 'STIM_NO_PROJECT') refuseNoProject({ json: Boolean(opts.json) });
        else report(result.error, Boolean(opts.json));
        return;
      }
      console.log(opts.json ? JSON.stringify(result.output) : result.text);
    });
}

export default function shareCommand(program: Command, version: string): void {
  registerShare(program, version);
}
