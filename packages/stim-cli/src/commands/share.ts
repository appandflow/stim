import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { RESERVED_SHARE_SLUGS, SHARE_SLUG_PATTERN, type Methods, type WebShareRow } from '@stim-cli/core/protocol';
import { shareLinkKey } from '@stim-cli/core/state';
import {
  LocalServerUnavailable,
  requestLocalServer,
  resolveShareServer,
  startShareServer,
  stopIdleShareServer,
  type ShareServerStop,
  type LocalServerAnswer,
  type ShareMethod,
  type ShareServerStart,
} from '../local-server.ts';
import { forgetShareLinks, pauseShareLinks, reusableShareLinks, saveShareLink } from '../workspace/share-links.ts';
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
  /** Start the saved link of this target again. */
  reuse?: boolean;
  /** With `stop`, delete the workspace's saved links. */
  forget?: boolean;
  json?: boolean;
}

export interface ShareDeps {
  findWorkspace: (cwd: string) => Promise<string | null>;
  request: <M extends ShareMethod>(method: M, params: Methods[M]['params']) => Promise<LocalServerAnswer<M>>;
  /** Starts a stim-server for this Stim home when none runs; null when no version-matched server is installed. */
  startServer: () => Promise<ShareServerStart | null>;
  /** Stops the stim-server `stim share` started, once it holds no share; returns its pid when it stopped one. */
  stopServer: () => Promise<ShareServerStop | null>;
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
  if (method === 'share.start' && /does not take (token|expiresAt)/.test(answer.error.message)) {
    return failure(
      'STIM_SHARE_REFUSED',
      'The running stim-server cannot start a saved share again.',
      'Update stim-server to the version of this stim (`stim-server service update`), then run stim share --reuse again.',
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

type ShareResult = { ok: true; output: object; text: string } | { ok: false; error: ShareFailure };

const plural = (count: number) => `${count} ${count === 1 ? 'share' : 'shares'}`;

const badArg = (message: string, remedy: string): ShareResult => ({
  ok: false,
  error: failure('STIM_BAD_ARG', message, remedy),
});

/** What the link and passwords of a started share say about who can open it. */
function secretLines(
  started: WebShareRow,
  passwords: { password?: string; viewPassword?: string },
  kept: 'saved' | 'unsaved' | 'reused',
) {
  const open = 'can open it from the internet until it expires';
  const shown = kept === 'saved' ? 'shown now and saved for --reuse' : 'shown only now';
  if (started.viewAuth) {
    return [
      `Control password: ${passwords.password ?? 'the one you set'}`,
      `View password:    ${passwords.viewPassword ?? 'the one you set'}`,
      kept !== 'reused' && (passwords.password !== undefined || passwords.viewPassword !== undefined)
        ? `Anyone with the link and a password ${open}. Generated passwords are ${shown}.`
        : `Anyone with the link and a password ${open}.`,
    ];
  }
  if (started.auth === 'none') return [`Password: none; anyone with the link ${open}.`];
  if (started.auth === 'set') return [`Password: the one you set; anyone with the link and it ${open}.`];
  return [
    `Password: ${passwords.password}`,
    kept === 'reused' ? `Anyone with both ${open}.` : `Anyone with both ${open}. The password is ${shown}.`,
  ];
}

/** The URL's token or slug and the address it is served under, up to `/s/`. */
function splitUrl(url: string, slug: string | undefined): { token?: string; origin: string } | null {
  const [, origin, path] = /^(.*\/s\/)([^/?#]+)\/?$/.exec(url) ?? [];
  if (origin === undefined || path === undefined) return null;
  if (slug !== undefined) return path === slug ? { origin } : null;
  return /^[A-Za-z0-9_-]{43}$/.test(path) ? { token: path, origin } : null;
}

/** Starts the workspace's saved link of this target again, with the passwords and setup it was first started with. */
async function reuseShare(
  root: string,
  platform: 'ios' | 'android',
  opts: ShareOptions,
  deps: ShareDeps,
  version: string,
): Promise<ShareResult> {
  const given = [
    opts.control && '--control',
    (typeof opts.password === 'string' || opts.password === false || opts.bothPasswords) && '--password',
    opts.viewPassword !== undefined && '--view-password',
  ].filter((flag): flag is string => typeof flag === 'string');
  if (given.length) {
    return badArg(
      `--reuse takes the control, view-only and password setup from the saved share, so it cannot be combined with ${given.join(' or ')}.`,
      'Leave those flags out, or start a new share without --reuse.',
    );
  }
  const minutes = opts.expires === undefined ? null : parseMinutes(opts.expires);
  if (typeof minutes === 'object' && minutes !== null) return { ok: false, error: minutes };
  const target = { platform, ...(opts.slot ? { slot: opts.slot } : {}), ...(opts.device ? { physical: true } : {}) };
  const key = shareLinkKey(target);
  const saved = reusableShareLinks(root)[key];
  const flags = `${opts.device ? ' --device' : ''}${opts.slot && opts.slot !== 'default' ? ` --slot ${opts.slot}` : ''}`;
  if (!saved) {
    return {
      ok: false,
      error: failure(
        'STIM_SHARE_NOTHING_TO_REUSE',
        `No saved link to reuse for ${platform}${opts.device ? ' device' : ''}${opts.slot && opts.slot !== 'default' ? ` (slot ${opts.slot})` : ''} of ${root}: no share was started for it, its link expired, or it was forgotten.`,
        `Run stim share ${platform}${flags} without --reuse to start a new share.`,
      ),
    };
  }
  if (saved.auth === 'none') {
    deps.note(
      `Warning: this share has no password. Anyone with the link can ${saved.control ? 'watch and control' : 'watch'} the device until it expires.`,
    );
  }
  const answer = await ask(
    deps,
    'share.start',
    {
      workspace: root,
      platform,
      ...(opts.slot && opts.slot !== 'default' ? { slot: opts.slot } : {}),
      ...(opts.device ? { physical: true } : {}),
      control: saved.control,
      ...(saved.slug === undefined ? { token: saved.token } : { slug: saved.slug }),
      ...(minutes === null ? { expiresAt: saved.expiresAt } : { expiresMinutes: minutes }),
      ...(saved.password === undefined ? { passwordless: true } : { password: saved.password }),
      ...(saved.viewPassword === undefined ? {} : { view: { password: saved.viewPassword } }),
    },
    version,
    true,
  );
  if ('code' in answer) return { ok: false, error: answer };
  const started = answer.result;
  if (started.warning) deps.note(`Warning: ${started.warning}`);
  const link = splitUrl(started.url, saved.slug);
  if (link && saved.origin && link.origin !== saved.origin) {
    deps.note(`The link is served under a different address than before; the link path is the same: ${link.origin}`);
  }
  try {
    saveShareLink(root, key, {
      ...saved,
      ...(link ? { origin: link.origin } : {}),
      state: 'live',
      expiresAt: started.expiresAt,
    });
  } catch (cause) {
    deps.note(`Warning: could not update the saved link: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const shared = { ...started, auth: saved.auth, viewAuth: saved.viewAuth };
  const passwords = {
    ...(saved.auth === 'generated' && saved.password !== undefined ? { password: saved.password } : {}),
    ...(saved.viewAuth === 'generated' && saved.viewPassword !== undefined ? { viewPassword: saved.viewPassword } : {}),
  };
  return {
    ok: true,
    output: { ...shared, ...passwords, reused: true },
    text: [
      `Shared ${describeRow(shared)}.`,
      'Started again with its saved link and password.',
      `URL:${shared.viewAuth ? '              ' : '      '}${shared.url}`,
      ...secretLines(shared, passwords, 'reused'),
      `Expires ${started.expiresAt}${minutes === null ? ' (the saved expiry)' : ''}.`,
      'Stop it with: stim share stop (add --forget to make the link unusable)',
    ].join('\n'),
  };
}

/** Ends this workspace's shares, keeps its saved links reusable, or with `--forget` deletes them. */
async function stopShares(root: string, opts: ShareOptions, deps: ShareDeps, version: string): Promise<ShareResult> {
  const saving = (action: () => void, what: string) => {
    try {
      action();
    } catch (cause) {
      deps.note(`Warning: could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  if (!opts.forget) saving(() => pauseShareLinks(root), 'mark the saved links stopped');
  let answer = await ask(deps, 'share.stop', { workspace: root }, version);
  if ('code' in answer && opts.forget && answer.code === 'STIM_SERVER_NOT_RUNNING') {
    answer = { result: { stopped: [] } };
  }
  if ('code' in answer) return { ok: false, error: answer };
  const { stopped } = answer.result;
  let forgot = 0;
  if (opts.forget) saving(() => (forgot = forgetShareLinks(root)), 'delete the saved links');
  const server = await deps.stopServer();
  let saved: ReturnType<typeof reusableShareLinks> = {};
  saving(() => (saved = reusableShareLinks(root)), 'read the saved links');
  const reusable = Object.values(saved).map((link) => ({
    platform: link.platform,
    slot: link.slot,
    physical: link.physical,
    expiresAt: link.expiresAt,
  }));
  const pausedLinks = stopped.some((row) =>
    reusable.some((link) => link.platform === row.platform && link.slot === row.slot && link.physical === row.physical),
  );
  return {
    ok: true,
    output: {
      stopped,
      ...(opts.forget ? { forgot } : { reusable }),
      ...(server === null
        ? {}
        : 'starting' in server
          ? { keptServer: server.pid, startingShares: server.starting }
          : { stoppedServer: server.pid, ...(server.exited ? {} : { stillStopping: true }) }),
    },
    text: [
      stopped.length
        ? `Stopped ${plural(stopped.length)}; ${stopped.length === 1 ? 'its link stops' : 'their links stop'} working${pausedLinks && !opts.forget ? ' until reused' : ''}.`
        : 'This workspace has no live web share.',
      ...(opts.forget
        ? [
            `Forgot ${forgot} saved ${forgot === 1 ? 'link' : 'links'}; ${forgot === 1 ? 'it' : 'they'} cannot be reused.`,
          ]
        : reusable.map((link) => {
            const flags = `${link.physical ? ' --device' : ''}${link.slot === 'default' ? '' : ` --slot ${link.slot}`}`;
            return `Reusable until ${link.expiresAt}: stim share ${link.platform}${flags} --reuse starts it again with the same link and password.`;
          })),
      ...(!opts.forget && reusable.length
        ? ['To make the saved links unusable now, run: stim share stop --forget']
        : []),
      ...(server === null
        ? []
        : 'starting' in server
          ? [
              `Left the stim-server stim share started (pid ${server.pid}) running: ${server.starting === 1 ? 'a share start is' : `${server.starting} share starts are`} still in progress. It exits by itself if ${server.starting === 1 ? 'that start leaves' : 'those starts leave'} no share.`,
            ]
          : [
              server.exited
                ? `Stopped the stim-server stim share started (pid ${server.pid}).`
                : `Asked the stim-server stim share started (pid ${server.pid}) to stop; it has not exited yet, so wait a moment before sharing again.`,
            ]),
    ].join('\n'),
  };
}

export async function runShare(
  action: string,
  opts: ShareOptions,
  deps: ShareDeps,
  version: string,
): Promise<ShareResult> {
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
  if (opts.forget && action !== 'stop') {
    return badArg('--forget works only with stim share stop.', 'Run stim share stop --forget.');
  }
  if (opts.reuse && action !== 'ios' && action !== 'android') {
    return badArg('--reuse works only with stim share ios or android.', 'Run stim share ios|android --reuse.');
  }
  if (action === 'stop') return stopShares(root, opts, deps, version);
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
  if (opts.reuse) return reuseShare(root, action, opts, deps, version);
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
  const link = splitUrl(started.url, started.slug);
  const password = chosen ?? started.password;
  const viewPassword = typeof view === 'string' ? view : started.viewPassword;
  let saved = false;
  if (
    link &&
    (started.auth === 'none' || password !== undefined) &&
    (!started.viewAuth || viewPassword !== undefined)
  ) {
    try {
      saveShareLink(root, shareLinkKey({ platform: action, slot: opts.slot, physical: opts.device }), {
        platform: action,
        slot: opts.slot ?? 'default',
        physical: opts.device === true,
        ...(link.token === undefined ? { slug: started.slug } : { token: link.token }),
        origin: link.origin,
        control: started.control,
        ...(started.auth === 'none' || password === undefined ? {} : { password }),
        ...(started.viewAuth && viewPassword !== undefined ? { viewPassword } : {}),
        auth: started.auth,
        viewAuth: started.viewAuth ?? null,
        state: 'live',
        createdAt: new Date().toISOString(),
        expiresAt: started.expiresAt,
      });
      saved = true;
    } catch (cause) {
      deps.note(
        `Warning: could not save the link for --reuse: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const secret = secretLines(started, started, saved ? 'saved' : 'unsaved');
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
      saved
        ? 'Stop it with: stim share stop (add --forget to make the link unusable)'
        : 'Stop it with: stim share stop',
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
      "Share this workspace's running app through a public web link, with a generated password unless you set or drop it: share ios|android starts one (and a stim-server, when none runs), share stop ends this workspace's shares, share list lists shares and whether one waits for its device. Every share's link and password are saved for share ios|android --reuse, which starts a stopped share again until it expires; share stop --forget deletes them.",
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
    .option(
      '--reuse',
      "Start the saved link and passwords of this workspace's last share of this target again, until it expires (not with --control, --password, --no-password or --view-password; --expires replaces the expiry)",
    )
    .option('--forget', "With stop, also delete this workspace's saved links so --reuse has nothing to start")
    .option(
      '--expires <minutes>',
      `Minutes until the share ends, 1 to ${MAX_MINUTES} (default ${DEFAULT_MINUTES}; with --reuse, the saved expiry)`,
    )
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
