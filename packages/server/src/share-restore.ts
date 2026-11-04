import { readLiveShareLinks, type LiveShareLink } from '@stim-cli/core/state';
import type { Refusal } from './share.ts';

const RETRY_MS = [5000, 10_000, 20_000, 40_000, 60_000];

/** The `share.start` params that start a saved share again under its link, passwords and expiry. */
export function savedShareParams({ workspace, share }: LiveShareLink): Record<string, unknown> {
  return {
    workspace,
    platform: share.platform,
    ...(share.slot !== 'default' ? { slot: share.slot } : {}),
    ...(share.physical ? { physical: true } : {}),
    control: share.control,
    ...(share.slug === undefined ? { token: share.token } : { slug: share.slug }),
    expiresAt: share.expiresAt,
    ...(share.password === undefined ? { passwordless: true } : { password: share.password }),
    ...(share.viewPassword === undefined ? {} : { view: { password: share.viewPassword } }),
  };
}

export interface ShareRestoreDeps {
  /** Starts a share from `share.start` params, waiting for its device when that is not there yet. */
  start: (params: Record<string, unknown>) => Promise<{ started: true; id: string } | Refusal>;
  /** Whether the saved entry is still `live` with the link and expiry `link` has: it is read again before every start. */
  wanted: (link: LiveShareLink) => boolean;
  /** Ends a share this module started after its saved entry was stopped or replaced. */
  end: (link: LiveShareLink, id: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  closed: () => boolean;
  log: (line: string) => void;
}

/**
 * Starts every unexpired share that `stim share` saved as `live` and no stim-server runs now, the way `--reuse` would:
 * the same link and passwords, until the saved expiry. A share the server cannot start yet (for example Tailscale is
 * not up after a restart) is tried again with a growing wait; one that is refused for its own sake (bad params, a link
 * already live) is left alone; one refused because the workspace's native-run claim is busy is tried again for as long
 * as the saved entry is wanted. A share stopped or replaced while a start was pending never stays up. Nothing here
 * writes the saved links.
 */
export async function restoreSavedShares(
  deps: ShareRestoreDeps,
  links: LiveShareLink[] = readLiveShareLinks(),
): Promise<void> {
  await Promise.all(links.map((link) => restoreOne(deps, link)));
}

async function restoreOne(deps: ShareRestoreDeps, link: LiveShareLink): Promise<void> {
  const what = `${link.share.platform}${link.share.slot === 'default' ? '' : `@${link.share.slot}`} of ${link.workspace}`;
  for (let attempt = 0; ; attempt++) {
    if (deps.closed() || !deps.wanted(link)) return;
    const answer = await deps.start(savedShareParams(link));
    if ('started' in answer) {
      if (!deps.wanted(link)) return deps.end(link, answer.id);
      return deps.log(`restored the web share of ${what}`);
    }
    if (answer.code !== 'action-failed' || (attempt >= RETRY_MS.length && !answer.busy)) {
      return deps.log(`did not restore the web share of ${what}: ${answer.message}`);
    }
    await deps.wait(RETRY_MS[attempt] ?? 60_000);
  }
}
