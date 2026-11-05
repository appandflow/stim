import type { MacSnapshot } from '@/lib/home';
import { isActive } from '@/lib/workspaces';

export interface RecentWorkspace {
  macId: string;
  path: string;
}

const LIMIT = 6;

const keyOf = (w: RecentWorkspace) => `${w.macId}\n${w.path}`;

/** Moves the workspaces to the front, in the given order, and keeps the newest few. */
export function touchRecents(recents: RecentWorkspace[], workspaces: RecentWorkspace[]): RecentWorkspace[] {
  const touched = new Set(workspaces.map(keyOf));
  return [...workspaces, ...recents.filter((r) => !touched.has(keyOf(r)))].slice(0, LIMIT);
}

/** Recents saved by this or an older app version; anything unreadable is dropped. */
export function parseRecents(raw: string | null): RecentWorkspace[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (v): v is RecentWorkspace =>
        typeof v === 'object' && v !== null && typeof v.macId === 'string' && typeof v.path === 'string',
    )
    .map(({ macId, path }) => ({ macId, path }))
    .slice(0, LIMIT);
}

/** The live workspace keys now, and the workspaces that were not live in `previous`. */
export function newlyLive(
  previous: ReadonlySet<string>,
  macs: MacSnapshot[],
): { live: Set<string>; started: RecentWorkspace[] } {
  const live = new Set<string>();
  const started: RecentWorkspace[] = [];
  for (const mac of macs) {
    for (const env of mac.status?.environments ?? []) {
      if (!isActive(env)) continue;
      const workspace = { macId: mac.id, path: env.path };
      live.add(keyOf(workspace));
      if (!previous.has(keyOf(workspace))) started.push(workspace);
    }
  }
  return { live, started };
}
