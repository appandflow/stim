import { splitShareUrl, type SavedShare } from '@stim-cli/core/state';
import type { ShareRequest, StartedShare } from './share.ts';

/**
 * The entry that makes a started share reusable and restorable, or null when its link or a password is not known.
 * `existing` is the entry already filed for the same target: when it holds the same link and the same passwords, as
 * `stim share --reuse` sends them back, its `auth`, `viewAuth` and `createdAt` carry over, because the server sees
 * a password that was generated at first as one the caller sets.
 */
export function savedShareFor(
  request: ShareRequest,
  started: StartedShare,
  existing: SavedShare | undefined,
  now: Date = new Date(),
): SavedShare | null {
  const link = splitShareUrl(started.url, started.slug);
  if (!link) return null;
  const password = request.password ?? started.password;
  const viewPassword = request.view?.password ?? started.viewPassword;
  if (started.auth !== 'none' && password === undefined) return null;
  if (started.viewAuth && viewPassword === undefined) return null;
  const same =
    existing !== undefined &&
    existing.token === link.token &&
    existing.slug === started.slug &&
    existing.password === (started.auth === 'none' ? undefined : password) &&
    existing.viewPassword === (started.viewAuth ? viewPassword : undefined);
  return {
    platform: request.platform,
    slot: request.slot ?? 'default',
    physical: request.physical === true,
    ...(link.token === undefined ? { slug: started.slug } : { token: link.token }),
    origin: link.origin,
    control: started.control,
    ...(started.auth === 'none' || password === undefined ? {} : { password }),
    ...(started.viewAuth && viewPassword !== undefined ? { viewPassword } : {}),
    auth: same ? existing.auth : started.auth,
    viewAuth: same ? existing.viewAuth : (started.viewAuth ?? null),
    state: 'live',
    createdAt: same ? existing.createdAt : now.toISOString(),
    expiresAt: started.expiresAt,
  };
}
