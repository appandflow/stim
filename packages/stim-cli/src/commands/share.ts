import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { RESERVED_SHARE_SLUGS, SHARE_SLUG_PATTERN, type Methods, type WebShareRow } from '@stim-cli/core/protocol';
import {
  LocalServerUnavailable,
  requestLocalServer,
  resolveShareServer,
  startShareServer,
  stopIdleShareServer,
  type LocalServerAnswer,
  type ShareMethod,
  type ShareServerStart,
} from '../local-server.ts';
import { findCommandWorkspaceAsync } from '../workspace/project.ts';
import { repoRootAsync } from '../workspace/worktree.ts';

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 480;
const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG = new RegExp(SHARE_SLUG_PATTERN);

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
  /** A string from `--password <value>`, false from `--no-password`. */
  password?: string | false;
  /** A string from `--view-password <value>`, true from `--view-password` alone. */
  viewPassword?: string | true;
  /** Both `--password` and `--no-password` were passed. */
  bothPasswords?: boolean;
  slug?: string;
  json?: boolean;
}

export interface ShareDeps {
  findWorkspace: (cwd: string) => Promise<string | null>;
  request: <M extends ShareMethod>(method: M, params: Methods[M]['params']) => Promise<LocalServerAnswer<M>>;
  /** Starts a stim-server for this Stim home when none runs; null when no version-matched server is installed. */
  startServer: () => Promise<ShareServerStart | null>;
  /** Stops the stim-server `stim share` started, once it holds no share; returns its pid when it stopped one. */
  stopServer: () => Promise<number | null>;
  /** Writes a line to stderr. */
  note: (line: string) => void;
  /** The host platform: stim-server serves its local socket everywhere but win32. */
  platform: NodeJS.Platform;
}

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const serverRemedy = (version: string) =>
  `Web shares run inside stim-server, and no stim-server ${version} is installed for stim share to start. Install it with \`npm install --global @stim-cli/server@${version}\`, or open Stim Desktop, then run stim share again.`;

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
  version: string,
  start = false,
): Promise<{ result: Methods[M]['result'] } | ShareFailure> {
  let answer: LocalServerAnswer<M>;
  try {
    answer = await deps.request(method, params);
  } catch (cause) {
    if (cause instanceof LocalServerUnavailable) {
      if (!start) {
        return failure(
          'STIM_SERVER_NOT_RUNNING',
          `No stim-server runs for this Stim home (${cause.message}).`,
          'Nothing is shared. stim share ios|android starts a stim-server when none runs.',
        );
      }
      const started = await deps.startServer();
      if (!started) {
        return failure('STIM_SERVER_NOT_RUNNING', `No stim-server runs for this Stim home.`, serverRemedy(version));
      }
      if (!started.started && started.reason === 'failed') {
        return failure(
          'STIM_SERVER_NOT_RUNNING',
          `${started.message} Its log is ${started.log}.`,
          'Read the log, fix what it names, then run stim share again.',
        );
      }
      if (started.started) {
        deps.note(
          `Started stim-server (pid ${started.pid}) for this share; its log is ${started.log}. It stops on its own when the last share ends; to stop it now, run \`stim share stop\`.`,
        );
      }
      return ask(deps, method, params, version);
    }
    return failure(
      'STIM_SHARE_REFUSED',
      cause instanceof Error ? cause.message : String(cause),
      'Check stim-server, then run stim share again.',
    );
  }
  if ('result' in answer) return answer;
  if (answer.error.code === 'unknown-method' || /does not take slug\b/.test(answer.error.message)) {
    return failure(
      'STIM_SHARE_REFUSED',
      answer.error.code === 'unknown-method'
        ? 'The running stim-server does not serve web shares.'
        : 'The running stim-server does not take --slug.',
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
  const mode = `${row.control ? 'view and control' : 'view only'}${row.auth === 'none' ? ', no password' : ''}${row.viewAuth ? ', view password' : ''}`;
  const waiting = row.state === 'waiting' ? ', waiting for the device' : '';
  const link = row.slug !== undefined ? `, link /s/${row.slug}/` : '';
  return `${target} of ${row.workspace}: ${mode}${link}${waiting}, ${row.viewers} viewer${row.viewers === 1 ? '' : 's'}, expires ${row.expiresAt}`;
}

export async function runShare(
  action: string,
  opts: ShareOptions,
  deps: ShareDeps,
  version: string,
): Promise<{ ok: true; output: object; text: string } | { ok: false; error: ShareFailure }> {
  if (deps.platform === 'win32') {
    return {
      ok: false,
      error: failure(
        'STIM_SHARE_REFUSED',
        'Web shares need the local stim-server socket, which is not available on Windows.',
        'Run stim share from the macOS or Linux host that runs the device.',
      ),
    };
  }
  if (action === 'list') {
    const answer = await ask(deps, 'share.list', {}, version);
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
    const answer = await ask(deps, 'share.stop', { workspace: root }, version);
    if ('code' in answer) return { ok: false, error: answer };
    const { stopped } = answer.result;
    const server = await deps.stopServer();
    return {
      ok: true,
      output: { stopped, ...(server !== null ? { stoppedServer: server } : {}) },
      text: [
        stopped.length
          ? `Stopped ${stopped.length} web share${stopped.length === 1 ? '' : 's'}; their links no longer work.`
          : 'This workspace has no live web share.',
        ...(server !== null ? [`Stopped the stim-server stim share started (pid ${server}).`] : []),
      ].join('\n'),
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
  if (opts.bothPasswords) {
    return {
      ok: false,
      error: failure('STIM_BAD_ARG', '--password and --no-password cannot be used together.', 'Pass one of them.'),
    };
  }
  const chosen = typeof opts.password === 'string' ? opts.password : undefined;
  if (chosen !== undefined && (chosen.length < MIN_PASSWORD || chosen.length > MAX_PASSWORD)) {
    return {
      ok: false,
      error: failure(
        'STIM_BAD_ARG',
        `--password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`,
        'Pass a longer password, or leave --password out to have one generated.',
      ),
    };
  }
  const passwordless = opts.password === false;
  const view = opts.viewPassword;
  if (view !== undefined) {
    if (!opts.control) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          '--view-password needs --control: a view-only share has one password already.',
          'Add --control, or use --password to set the only password.',
        ),
      };
    }
    if (passwordless) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          '--view-password and --no-password cannot be used together.',
          'Leave --no-password out, or leave --view-password out.',
        ),
      };
    }
    if (typeof view === 'string' && (view.length < MIN_PASSWORD || view.length > MAX_PASSWORD)) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          `--view-password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`,
          'Pass a longer password, or leave the value out to have one generated.',
        ),
      };
    }
    if (typeof view === 'string' && view === chosen) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          '--view-password and --password must differ.',
          'Pass two different passwords, or leave one out to have it generated.',
        ),
      };
    }
  }
  if (opts.slug !== undefined) {
    if (!SLUG.test(opts.slug) || RESERVED_SHARE_SLUGS.includes(opts.slug)) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          `--slug ${JSON.stringify(opts.slug)} is not a share slug.`,
          RESERVED_SHARE_SLUGS.includes(opts.slug)
            ? `${opts.slug} is reserved for the share pages; choose another slug.`
            : 'Use 3 to 32 lowercase letters, digits and hyphens, starting and ending with a letter or digit, such as --slug pokedex.',
        ),
      };
    }
    if (passwordless) {
      return {
        ok: false,
        error: failure(
          'STIM_BAD_ARG',
          '--slug and --no-password cannot be used together: anyone can guess a slug, so the password is what keeps the share private.',
          'Leave --no-password out to have a password generated, or leave --slug out to get a random link.',
        ),
      };
    }
  }
  if (passwordless) {
    deps.note(
      `Warning: this share has no password. Anyone with the link can ${opts.control ? 'watch and control' : 'watch'} the device until it expires.`,
    );
  }
  const answer = await ask(
    deps,
    'share.start',
    {
      workspace: root,
      platform: action,
      ...(opts.slot && opts.slot !== 'default' ? { slot: opts.slot } : {}),
      ...(opts.device ? { physical: true } : {}),
      control: opts.control === true,
      expiresMinutes: minutes,
      ...(chosen !== undefined ? { password: chosen } : {}),
      ...(passwordless ? { passwordless: true } : {}),
      ...(view !== undefined ? { view: typeof view === 'string' ? { password: view } : {} } : {}),
      ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
    },
    version,
    true,
  );
  if ('code' in answer) return { ok: false, error: answer };
  const started = answer.result;
  if (started.warning) deps.note(`Warning: ${started.warning}`);
  const secret = started.viewAuth
    ? [
        `Control password: ${started.password ?? 'the one you set'}`,
        `View password:    ${started.viewPassword ?? 'the one you set'}`,
        started.password !== undefined || started.viewPassword !== undefined
          ? 'Anyone with the link and a password can open it from the internet until it expires. Generated passwords are shown only now.'
          : 'Anyone with the link and a password can open it from the internet until it expires.',
      ]
    : started.auth === 'none'
      ? ['Password: none; anyone with the link can open it from the internet until it expires.']
      : started.auth === 'set'
        ? ['Password: the one you set; anyone with the link and it can open it from the internet until it expires.']
        : [
            `Password: ${started.password}`,
            'Anyone with both can open it from the internet until it expires. The password is shown only now.',
          ];
  return {
    ok: true,
    output: started,
    text: [
      `Shared ${describeRow(started)}.`,
      `URL:${started.viewAuth ? '              ' : '      '}${started.url}`,
      ...secret,
      ...(started.slug !== undefined
        ? ['The link uses a chosen slug, so anyone can guess it: only the password keeps the share private.']
        : []),
      'Stop it with: stim share stop',
    ].join('\n'),
  };
}

const DEFAULT_DEPS = (version: string): ShareDeps => ({
  findWorkspace: (cwd) => findCommandWorkspaceAsync(cwd, repoRootAsync, (line) => console.error(line)),
  request: (method, params) => requestLocalServer(method, params, { version }),
  startServer: async () => {
    const server = await resolveShareServer(version);
    return server ? startShareServer(server, version) : null;
  },
  stopServer: () => stopIdleShareServer(version),
  note: (line) => console.error(line),
  platform: process.platform,
});

export function registerShare(program: Command, version: string, deps: Partial<ShareDeps> = {}): void {
  program
    .command('share <action>')
    .description(
      "Share this workspace's running app through a public web link, with a generated password unless you set or drop it: share ios|android starts one (and a stim-server, when none runs), share stop ends this workspace's shares, share list lists shares and whether one waits for its device.",
    )
    .option('--slot <name>', 'Share the device of this slot')
    .option('--device', 'Share the physical device this workspace leases instead of its simulator or emulator')
    .option('--control', 'Let viewers tap, type and press buttons (watch only without it)')
    .option('--password <value>', 'Use this password (8 to 128 characters) instead of a generated one')
    .option('--no-password', 'Need no password: anyone with the link can open the share')
    .option(
      '--view-password [value]',
      'With --control, a second password that only watches (8 to 128 characters, generated without a value)',
    )
    .option(
      '--slug <name>',
      'Use /s/<name>/ as the link instead of a random token (3 to 32 lowercase letters, digits and hyphens; needs a password)',
    )
    .option('--expires <minutes>', `Minutes until the share ends, 1 to ${MAX_MINUTES}`, String(DEFAULT_MINUTES))
    .option('--json', 'Emit one JSON payload')
    .action(async (action: string, opts: ShareOptions) => {
      const args = process.argv.slice(2);
      const bothPasswords =
        args.includes('--no-password') && args.some((arg) => arg === '--password' || arg.startsWith('--password='));
      const result = await runShare(action, { ...opts, bothPasswords }, { ...DEFAULT_DEPS(version), ...deps }, version);
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
