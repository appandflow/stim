import { type ShareRequest, type StartedShare, SHARE_EXPIRY } from '../share.ts';
import { saveShareLinkAsync, pauseShareLinkAsync, pauseShareLinksAsync } from 'stim/share-links';
import { shareLinkKey, isJsonObject, SHARE_TOKEN } from '@stim-cli/core/state';
import { savedShareFor } from '../share-save.ts';
import { SHARE_SLUG_PATTERN, RESERVED_SHARE_SLUGS, type RequestId } from '../protocol.ts';
import { SLOT_NAME } from '../control.ts';
import { send, registeredWorkspace, type ConnectionContext } from './context.ts';

/** Saves a started share through the CLI's share-links module; false when it could not (nothing logs a password). */
async function saveStartedShare(request: ShareRequest, started: StartedShare): Promise<boolean> {
  try {
    let saved = false;
    await saveShareLinkAsync(request.workspace, shareLinkKey(request), (existing) => {
      const entry = savedShareFor(request, started, existing);
      if (!entry) throw new Error('its link or a password is not known');
      saved = true;
      return entry;
    });
    return saved;
  } catch (cause) {
    console.error(
      `stim-server: could not save the web share ${started.id} for reuse and restart: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return false;
  }
}

/** A share stopped on purpose must not come back when stim-server starts: marks its saved link stopped; why it could not. */
export async function markSavedStopped(mark: () => Promise<void>): Promise<string | null> {
  try {
    await mark();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

const SHARE_SLUG = new RegExp(SHARE_SLUG_PATTERN);

/** Validates `share.start` params; returns why they are refused. */
export function parseShareStart(params: unknown): (Omit<ShareRequest, 'workspace'> & { workspace: string }) | string {
  if (!isJsonObject(params)) return 'params must be an object.';
  const {
    workspace,
    platform,
    slot,
    physical,
    control,
    expiresMinutes,
    expiresAt,
    token,
    password,
    passwordless,
    view,
    slug,
    ...rest
  } = params;
  if (Object.keys(rest).length) return `share.start does not take ${Object.keys(rest).join(', ')}.`;
  if (typeof workspace !== 'string') return 'params.workspace must be a workspace path.';
  if (platform !== 'ios' && platform !== 'android') return 'params.platform must be ios or android.';
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot)))
    return 'params.slot must be 1-64 letters, digits, underscores or hyphens.';
  if (physical !== undefined && typeof physical !== 'boolean') return 'params.physical must be true or false.';
  if (control !== undefined && typeof control !== 'boolean') return 'params.control must be true or false.';
  if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 128))
    return 'params.password must be 8 to 128 characters.';
  if (passwordless !== undefined && typeof passwordless !== 'boolean')
    return 'params.passwordless must be true or false.';
  if (passwordless && password !== undefined) return 'A share takes a password or passwordless, not both.';
  if (view !== undefined) {
    if (!isJsonObject(view) || Object.keys(view).some((key) => key !== 'password'))
      return 'params.view must be an object that takes only password.';
    if (
      view.password !== undefined &&
      (typeof view.password !== 'string' || view.password.length < 8 || view.password.length > 128)
    )
      return 'params.view.password must be 8 to 128 characters.';
    if (control !== true || passwordless) return 'params.view needs control and a password.';
    if (view.password !== undefined && view.password === password)
      return 'The view password and the control password must differ.';
  }
  if (slug !== undefined) {
    if (typeof slug !== 'string' || !SHARE_SLUG.test(slug))
      return 'params.slug must be 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.';
    if (RESERVED_SHARE_SLUGS.includes(slug)) return `params.slug cannot be ${slug}: the share pages use that path.`;
    if (passwordless) return 'A share with a slug needs a password: anyone can guess a slug.';
  }
  if (token !== undefined && slug !== undefined) return 'A share takes a slug or a token, not both.';
  if (token !== undefined && (typeof token !== 'string' || !SHARE_TOKEN.test(token)))
    return 'params.token must be a 43-character URL token.';
  if (expiresAt !== undefined && expiresMinutes !== undefined)
    return 'A share takes expiresMinutes or expiresAt, not both.';
  let until: number | undefined;
  if (expiresAt !== undefined) {
    until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + SHARE_EXPIRY.max * 60_000)
      return `params.expiresAt must be a time within the next ${SHARE_EXPIRY.max} minutes.`;
  }
  const minutes =
    until === undefined ? (expiresMinutes ?? SHARE_EXPIRY.default) : Math.ceil((until - Date.now()) / 60_000);
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > SHARE_EXPIRY.max)
    return `params.expiresMinutes must be a whole number of minutes from 1 to ${SHARE_EXPIRY.max}.`;
  return {
    workspace,
    platform,
    ...(slot && slot !== 'default' ? { slot } : {}),
    ...(physical ? { physical } : {}),
    control: control === true,
    expiresMinutes: minutes,
    ...(until === undefined ? {} : { expiresAt: until }),
    ...(token === undefined ? {} : { token }),
    ...(typeof password === 'string' ? { password } : {}),
    ...(passwordless ? { passwordless } : {}),
    ...(view ? { view: typeof view.password === 'string' ? { password: view.password } : {} } : {}),
    ...(typeof slug === 'string' ? { slug } : {}),
  };
}

export async function shareMethod(
  ctx: ConnectionContext,
  id: RequestId,
  method: 'share.start' | 'share.stop' | 'share.list',
  params: unknown,
): Promise<void> {
  if (!ctx.local) return ctx.error(id, 'forbidden', `${method} works only on this machine's local Unix socket.`);
  if (method === 'share.list') {
    if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length))
      return ctx.error(id, 'bad-request', 'share.list takes no parameters.');
    return send(ctx.socket, { id, result: { shares: ctx.shares.list(), starting: ctx.shares.startsInFlight } });
  }
  if (method === 'share.stop') {
    if (
      !isJsonObject(params) ||
      typeof params.workspace !== 'string' ||
      (params.id !== undefined && (typeof params.id !== 'string' || params.id === '')) ||
      (params.slot !== undefined && (typeof params.slot !== 'string' || !SLOT_NAME.test(params.slot))) ||
      Object.keys(params).some((key) => key !== 'workspace' && key !== 'id' && key !== 'slot')
    )
      return ctx.error(
        id,
        'bad-request',
        'share.stop needs params.workspace and takes an optional params.id or params.slot.',
      );
    if (params.id !== undefined && params.slot !== undefined)
      return ctx.error(id, 'bad-request', 'share.stop takes params.id or params.slot, not both.');
    const workspace = params.workspace;
    const slot = typeof params.slot === 'string' ? params.slot : undefined;
    const row = params.id === undefined ? undefined : ctx.shares.list().find((each) => each.id === params.id);
    if (params.id !== undefined && (!row || row.workspace !== workspace))
      return ctx.error(id, 'bad-request', `No share ${params.id} in this workspace.`);
    const unsaved = await markSavedStopped(() =>
      row ? pauseShareLinkAsync(workspace, shareLinkKey(row)) : pauseShareLinksAsync(workspace, slot),
    );
    const stopped = row
      ? [await ctx.shares.stopOne(workspace, row.id)]
      : await ctx.shares.stop(workspace, undefined, slot);
    if (unsaved)
      return ctx.error(
        id,
        'action-failed',
        `The share stopped, but its saved link could not be marked stopped (${unsaved}), so a stim-server restart can start it again. Run stim share stop --forget.`,
      );
    return send(ctx.socket, { id, result: { stopped: stopped.filter((each) => each !== null) } });
  }
  const parsed = parseShareStart(params);
  if (typeof parsed === 'string') return ctx.error(id, 'bad-request', parsed);
  const resolved = registeredWorkspace(parsed.workspace);
  if ('code' in resolved) return ctx.error(id, resolved.code, resolved.message);
  const request = { ...parsed, workspace: resolved.dir };
  const started = await ctx.shares.start(request);
  if ('code' in started) return send(ctx.socket, { id, error: started });
  const saved = await saveStartedShare(request, started);
  if (saved && !ctx.shares.list().some((row) => row.id === started.id)) {
    await markSavedStopped(() => pauseShareLinkAsync(request.workspace, shareLinkKey(request)));
  }
  return send(ctx.socket, { id, result: saved ? { ...started, saved: true } : started });
}
