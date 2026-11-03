import { workspaceShareLinksFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';

/** A web share's link and passwords, as `stim share` saved them when it started so `--reuse` can start it again. */
export interface SavedShare {
  platform: 'ios' | 'android';
  slot: string;
  physical: boolean;
  /** The 43-character URL token: the share's 256-bit secret. */
  token: string;
  /** The address the link was served under, up to `/s/`; not a secret. */
  origin?: string;
  control: boolean;
  /** Without it the share has no login (`auth` is `none`). */
  password?: string;
  /** The separate view-only password of a share with control. */
  viewPassword?: string;
  /** How the passwords were made when the share first started. */
  auth: 'generated' | 'set' | 'none';
  viewAuth: 'generated' | 'set' | null;
  createdAt: string;
  expiresAt: string;
}

/** What a saved share is of: a platform's device in a slot, the simulator or emulator or the leased physical device. */
export interface ShareLinkTarget {
  platform: 'ios' | 'android';
  slot?: string;
  physical?: boolean;
}

export const SHARE_TOKEN: RegExp = /^[A-Za-z0-9_-]{43}$/;

/** The key a target's saved share is filed under: `ios`, `android:device`, `ios@tablet`. */
export function shareLinkKey(target: ShareLinkTarget): string {
  const slot = target.slot && target.slot !== 'default' ? `@${target.slot}` : '';
  return `${target.platform}${target.physical ? ':device' : ''}${slot}`;
}

const isPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && value.length <= 128;

function savedShare(value: unknown, now: number): SavedShare | null {
  if (!isJsonObject(value)) return null;
  const { platform, slot, physical, token, origin, control, password, viewPassword, auth, viewAuth } = value;
  const { createdAt, expiresAt } = value;
  if (platform !== 'ios' && platform !== 'android') return null;
  if (typeof slot !== 'string' || typeof physical !== 'boolean') return null;
  if (typeof token !== 'string' || !SHARE_TOKEN.test(token) || typeof control !== 'boolean') return null;
  if (typeof createdAt !== 'string' || typeof expiresAt !== 'string' || !(Date.parse(expiresAt) > now)) return null;
  if (auth !== 'generated' && auth !== 'set' && auth !== 'none') return null;
  if (viewAuth !== null && viewAuth !== 'generated' && viewAuth !== 'set') return null;
  if (auth === 'none' ? password !== undefined : !isPassword(password)) return null;
  if (viewAuth === null ? viewPassword !== undefined : !isPassword(viewPassword)) return null;
  return {
    platform,
    slot,
    physical,
    token,
    ...(typeof origin === 'string' ? { origin } : {}),
    control,
    ...(password === undefined ? {} : { password: String(password) }),
    ...(viewPassword === undefined ? {} : { viewPassword: String(viewPassword) }),
    auth,
    viewAuth,
    createdAt,
    expiresAt,
  };
}

/** The workspace's saved shares by {@link shareLinkKey} that have not expired; an unreadable or invalid entry is absent. */
export function readShareLinks(root: string, now: number = Date.now()): Record<string, SavedShare> {
  let file: unknown;
  try {
    file = readJsonFile(workspaceShareLinksFile(root));
  } catch {
    return {};
  }
  const links = isJsonObject(file) && isJsonObject(file.links) ? file.links : {};
  const kept: Record<string, SavedShare> = {};
  for (const [key, value] of Object.entries(links)) {
    const share = savedShare(value, now);
    if (share) kept[key] = share;
  }
  return kept;
}
