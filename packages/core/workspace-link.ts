export const WORKSPACE_LINK_ORIGIN = 'https://stim.appandflow.com';

/** A navigation destination on one Stim home, resolved only through an already-paired server. */
export interface SharedWorkspaceLink {
  machine: string;
  workspace: string;
  platform?: 'ios' | 'android' | 'macos' | 'web';
  slot?: string;
}

export function validHomeId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Parses a v1 HTTPS workspace link; unsupported origins, destinations and ambiguous query fields return null. */
export function parseWorkspaceLink(value: string): SharedWorkspaceLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== WORKSPACE_LINK_ORIGIN ||
    url.username ||
    url.password ||
    !['/open', '/open/'].includes(url.pathname)
  )
    return null;
  const params = url.searchParams;
  for (const name of ['v', 'machine', 'workspace', 'platform', 'slot']) if (params.getAll(name).length > 1) return null;
  const machine = params.get('machine');
  const workspace = params.get('workspace');
  if (params.get('v') !== '1' || !validHomeId(machine) || !workspace || !/^[0-9a-f]{16}$/.test(workspace)) return null;
  const platform = params.get('platform');
  const slot = params.get('slot');
  const link: SharedWorkspaceLink = {
    machine: machine.toLowerCase(),
    workspace,
    ...(slot && slot !== 'default' ? { slot } : {}),
  };
  if (platform) {
    if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') return null;
    link.platform = platform;
  }
  return link;
}

/** Builds a share URL containing only nonsecret destination identifiers. */
export function sharedWorkspaceURL(link: SharedWorkspaceLink): string {
  const url = new URL('/open', WORKSPACE_LINK_ORIGIN);
  url.searchParams.set('v', '1');
  url.searchParams.set('machine', link.machine);
  url.searchParams.set('workspace', link.workspace);
  if (link.platform) url.searchParams.set('platform', link.platform);
  if (link.slot && link.slot !== 'default') url.searchParams.set('slot', link.slot);
  return url.href;
}
