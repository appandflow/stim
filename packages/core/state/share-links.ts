import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { RESERVED_SHARE_SLUGS, SHARE_SLUG_PATTERN } from '../protocol.ts';
import { workspaceMetadataFile, workspaceShareLinksFile } from './paths.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';

/**
 * Whether a saved share should run again on its own: `live` from when it starts until a deliberate stop (`stim share
 * stop`, `stim stop`, `share.stop` from any client, a reclaimed workspace) or until stim-server ends it because its
 * device cannot stream, `stopped` after. A stim-server restart or crash leaves it `live`, because only a start, a
 * deliberate stop and that give-up write it.
 */
export type SavedShareState = 'live' | 'stopped';

/** A web share's link and passwords, as saved when it started so `--reuse` and a stim-server restart can start it again. */
export interface SavedShare {
  platform: 'ios' | 'android';
  slot: string;
  physical: boolean;
  /** The 43-character URL token: the share's 256-bit secret. Absent for a share with a chosen `slug`. */
  token?: string;
  /** The chosen link path of a share started with `--slug`; not a secret, the password is. */
  slug?: string;
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
  state: SavedShareState;
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
const SHARE_SLUG = new RegExp(SHARE_SLUG_PATTERN);

/** The key a target's saved share is filed under: `ios`, `android:device`, `ios@tablet`. */
export function shareLinkKey(target: ShareLinkTarget): string {
  const slot = target.slot && target.slot !== 'default' ? `@${target.slot}` : '';
  return `${target.platform}${target.physical ? ':device' : ''}${slot}`;
}

/** The URL's token or slug and the address it is served under, up to `/s/`. */
export function splitShareUrl(url: string, slug: string | undefined): { token?: string; origin: string } | null {
  const [, origin, path] = /^(.*\/s\/)([^/?#]+)\/?$/.exec(url) ?? [];
  if (origin === undefined || path === undefined) return null;
  if (slug !== undefined) return path === slug ? { origin } : null;
  return SHARE_TOKEN.test(path) ? { token: path, origin } : null;
}

const isPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && value.length <= 128;

function savedShare(value: unknown, now: number): SavedShare | null {
  if (!isJsonObject(value)) return null;
  const { platform, slot, physical, token, slug, origin, control, password, viewPassword, auth, viewAuth, state } =
    value;
  const { createdAt, expiresAt } = value;
  if (platform !== 'ios' && platform !== 'android') return null;
  if (typeof slot !== 'string' || typeof physical !== 'boolean') return null;
  if (typeof control !== 'boolean') return null;
  if (slug === undefined) {
    if (typeof token !== 'string' || !SHARE_TOKEN.test(token)) return null;
  } else if (
    token !== undefined ||
    typeof slug !== 'string' ||
    !SHARE_SLUG.test(slug) ||
    RESERVED_SHARE_SLUGS.includes(slug)
  ) {
    return null;
  }
  if (typeof createdAt !== 'string' || typeof expiresAt !== 'string' || !(Date.parse(expiresAt) > now)) return null;
  if (auth !== 'generated' && auth !== 'set' && auth !== 'none') return null;
  if (viewAuth !== null && viewAuth !== 'generated' && viewAuth !== 'set') return null;
  if (auth === 'none' ? password !== undefined : !isPassword(password)) return null;
  if (viewAuth === null ? viewPassword !== undefined : !isPassword(viewPassword)) return null;
  return {
    platform,
    slot,
    physical,
    ...(typeof token === 'string' ? { token } : {}),
    ...(typeof slug === 'string' ? { slug } : {}),
    ...(typeof origin === 'string' ? { origin } : {}),
    control,
    ...(password === undefined ? {} : { password: String(password) }),
    ...(viewPassword === undefined ? {} : { viewPassword: String(viewPassword) }),
    auth,
    viewAuth,
    state: state === 'live' ? 'live' : 'stopped',
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

/** A saved share that should run again, with the workspace it belongs to. */
export interface LiveShareLink {
  /** The project root the share was started for. */
  workspace: string;
  /** Its {@link shareLinkKey} in that workspace. */
  key: string;
  share: SavedShare;
}

/**
 * Every unexpired saved share in this Stim home whose state is `live`, across its workspaces. A workspace whose
 * metadata or file cannot be read has none.
 */
export function readLiveShareLinks(now: number = Date.now()): LiveShareLink[] {
  const found: LiveShareLink[] = [];
  let names: string[];
  try {
    names = readdirSync(join(configDir(), 'workspaces'));
  } catch {
    return found;
  }
  for (const name of names) {
    let metadata: unknown;
    try {
      metadata = readJsonFile(join(configDir(), 'workspaces', name, 'workspace.json'));
    } catch {
      continue;
    }
    const root = isJsonObject(metadata) ? metadata.projectRoot : undefined;
    if (
      typeof root !== 'string' ||
      workspaceMetadataFile(root) !== join(configDir(), 'workspaces', name, 'workspace.json')
    ) {
      continue;
    }
    for (const [key, share] of Object.entries(readShareLinks(root, now))) {
      if (share.state === 'live') found.push({ workspace: root, key, share });
    }
  }
  return found;
}
