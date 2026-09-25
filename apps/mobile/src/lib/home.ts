import {
  devicesOf,
  isActive,
  pathInCheckout,
  projectOf,
  repositoryRoots,
  workspaceNames,
  type DeviceRef,
} from '@/lib/workspaces';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

export interface MacSnapshot {
  id: string;
  name: string;
  status: StatusPayload | null;
}

export interface HomeItem {
  key: string;
  macId: string;
  macName: string;
  project: string;
  title: string;
  inCheckout: string | null;
  env: EnvironmentState;
}

const activityRank = (env: EnvironmentState) => (env.build?.state === 'running' ? 2 : isActive(env) ? 1 : 0);

/** Every workspace of every Mac: building first, then live, then idle; by project and name inside each. */
export function mergeWorkspaces(macs: MacSnapshot[]): HomeItem[] {
  const items: HomeItem[] = [];
  for (const mac of macs) {
    if (!mac.status) continue;
    const roots = repositoryRoots(mac.status);
    for (const env of mac.status.environments) {
      items.push({
        key: `${mac.id}\n${env.path}`,
        macId: mac.id,
        macName: mac.name,
        project: projectOf(env, roots).name,
        title: workspaceNames(env.path).title,
        inCheckout: pathInCheckout(env, roots),
        env,
      });
    }
  }
  return items.sort(
    (a, b) =>
      activityRank(b.env) - activityRank(a.env) ||
      a.project.localeCompare(b.project) ||
      a.title.localeCompare(b.title) ||
      a.macName.localeCompare(b.macName),
  );
}

export type ActivityFilter = 'live' | 'idle' | 'all';

export interface HomeFilters {
  /** Mac ids to show; empty shows every Mac. */
  macs: string[];
  /** Project names to show; empty shows every project. */
  projects: string[];
  activity: ActivityFilter;
  errorsOnly: boolean;
  remoteOnly: boolean;
}

export const DEFAULT_FILTERS: HomeFilters = {
  macs: [],
  projects: [],
  activity: 'live',
  errorsOnly: false,
  remoteOnly: false,
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Filters saved by this or an older app version; anything unreadable falls back to the defaults. */
export function parseFilters(raw: string | null): HomeFilters {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  if (!value || typeof value !== 'object') return DEFAULT_FILTERS;
  const saved = value as Record<string, unknown>;
  return {
    macs: strings(saved.macs),
    projects: strings(saved.projects),
    activity: saved.activity === 'idle' || saved.activity === 'all' ? saved.activity : 'live',
    errorsOnly: saved.errorsOnly === true,
    remoteOnly: saved.remoteOnly === true,
  };
}

/** Whether any filter differs from the defaults, for the dot on the filter button. */
export function filtersActive(filters: HomeFilters, macIds: string[], projects: string[]): boolean {
  return (
    filters.macs.some((id) => macIds.includes(id)) ||
    filters.projects.some((name) => projects.includes(name)) ||
    filters.activity !== DEFAULT_FILTERS.activity ||
    filters.errorsOnly ||
    filters.remoteOnly
  );
}

const hasErrors = (env: EnvironmentState) => (env.logs?.errorsSinceMarker ?? 0) > 0;
const hasRemote = (env: EnvironmentState) => (env.remoteDevices?.length ?? 0) > 0;

/**
 * The items the filters keep, and how many more the activity filter alone hides. A selected machine that is no
 * longer paired, or a selected project no machine lists any more, is ignored, so it cannot hide everything.
 */
export function filterWorkspaces(
  items: HomeItem[],
  filters: HomeFilters,
  macIds: string[],
): { shown: HomeItem[]; hiddenByActivity: number } {
  const macs = filters.macs.filter((id) => macIds.includes(id));
  const projects = filters.projects.filter((name) => items.some((item) => item.project === name));
  const shown: HomeItem[] = [];
  let hiddenByActivity = 0;
  for (const item of items) {
    if (macs.length && !macs.includes(item.macId)) continue;
    if (projects.length && !projects.includes(item.project)) continue;
    if (filters.errorsOnly && !hasErrors(item.env)) continue;
    if (filters.remoteOnly && !hasRemote(item.env)) continue;
    const active = isActive(item.env);
    if ((filters.activity === 'live' && !active) || (filters.activity === 'idle' && active)) {
      hiddenByActivity += 1;
      continue;
    }
    shown.push(item);
  }
  return { shown, hiddenByActivity };
}

export interface DeviceTileItem {
  key: string;
  item: HomeItem;
  device: DeviceRef;
}

/**
 * The devices grid's rows, in order: two portrait tiles side by side, and a tile whose last frame was wider than
 * tall (a landscape tablet, an unfolded iPhone Duo) alone across the row. `aspects` holds each tile's last frame
 * width over height; a tile with no frame yet counts as portrait.
 */
export function gridRows(tiles: DeviceTileItem[], aspects: ReadonlyMap<string, number>): DeviceTileItem[][] {
  const rows: DeviceTileItem[][] = [];
  let pair: DeviceTileItem[] = [];
  for (const tile of tiles) {
    if ((aspects.get(tile.key) ?? 0) > 1) {
      if (pair.length) rows.push(pair);
      pair = [];
      rows.push([tile]);
    } else {
      pair.push(tile);
      if (pair.length === 2) {
        rows.push(pair);
        pair = [];
      }
    }
  }
  if (pair.length) rows.push(pair);
  return rows;
}

/**
 * Every running device of the workspaces the machine and project filters keep, whatever their activity,
 * errors or remote sessions, in the list's order.
 */
export function runningDevices(items: HomeItem[], filters: HomeFilters, macIds: string[]): DeviceTileItem[] {
  const { shown } = filterWorkspaces(
    items,
    { ...filters, activity: 'all', errorsOnly: false, remoteOnly: false },
    macIds,
  );
  return shown.flatMap((item) =>
    devicesOf(item.env)
      .filter((device) => device.running)
      .map((device) => ({ key: `${item.key}\n${device.platform}\n${device.slot}`, item, device })),
  );
}

export function projectNames(items: HomeItem[]): string[] {
  return [...new Set(items.map((item) => item.project))].sort((a, b) => a.localeCompare(b));
}

export const LOW_DISK_BYTES = 20e9;

/** Decimal units, like the Finder and Stim Desktop's disk figures. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  const gb = bytes / 1e9;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** Binary units labeled GB, like Activity Monitor's memory figures. */
export const memoryGb = (bytes: number) => bytes / 2 ** 30;

export type UsageTone = 'normal' | 'warn' | 'critical';

export type StatKind = 'cpu' | 'memory' | 'disk';

export interface MachineStat {
  kind: StatKind;
  label: string;
  value: string;
  tone: UsageTone;
}

const CPU_WARN_FRACTION = 0.8;
const CPU_CRITICAL_FRACTION = 0.95;
// A quarter of the low-disk warning, so the compact stat also has a red tier before Stim's own hard floor bites.
const DISK_CRITICAL_BYTES = LOW_DISK_BYTES / 4;

/**
 * The chip and sheet's compact stats: CPU busy fraction, the Mac's memory used of total, and the lowest free
 * space of Stim's volumes. A stat is left out when the server or platform cannot report it.
 */
export function machineStats(usage: MachineUsage | null): MachineStat[] {
  if (!usage) return [];
  const stats: MachineStat[] = [];
  if (typeof usage.cpu.usage === 'number') {
    const fraction = usage.cpu.usage;
    stats.push({
      kind: 'cpu',
      label: 'CPU',
      value: `${Math.round(fraction * 100)}%`,
      tone: fraction >= CPU_CRITICAL_FRACTION ? 'critical' : fraction >= CPU_WARN_FRACTION ? 'warn' : 'normal',
    });
  }
  const used = usage.memory.usedBytes;
  if (typeof used === 'number') {
    stats.push({
      kind: 'memory',
      label: 'RAM',
      value: `${Math.round(memoryGb(used))}/${Math.round(memoryGb(usage.memory.totalBytes))} GB`,
      tone: usage.memory.pressure === 'critical' ? 'critical' : usage.memory.pressure === 'warning' ? 'warn' : 'normal',
    });
  }
  const lowest = usage.volumes.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest !== null) {
    stats.push({
      kind: 'disk',
      label: 'Disk',
      value: `${Math.round(lowest / 1e9)} GB free`,
      tone: lowest < DISK_CRITICAL_BYTES ? 'critical' : lowest < LOW_DISK_BYTES ? 'warn' : 'normal',
    });
  }
  return stats;
}

export interface BudgetRow {
  label: string;
  value: string;
}

const BUDGETS: { key: string; label: string; describe: (value: number | null) => string }[] = [
  {
    key: 'budget.minFreeDiskGb',
    label: 'Reclaims disk',
    describe: (v) => (v ? `below ${v} GB free` : 'only below the hard floor'),
  },
  { key: 'budget.hardFloorDiskGb', label: 'Refuses to run', describe: (v) => (v ? `below ${v} GB free` : 'never') },
  {
    key: 'budget.maxCommittedMemoryGb',
    label: 'Memory budget',
    describe: (v) => (v === null ? '60% of memory' : v === 0 ? 'off' : `${v} GB`),
  },
  { key: 'budget.maxLiveWorkspaces', label: 'Live workspaces', describe: (v) => (v ? String(v) : 'no limit') },
];

/** The budget rows of a `stim settings --json` payload; settings the Mac does not list are left out. */
export function budgetRows(settings: Record<string, unknown> | null): BudgetRow[] {
  const entries = Array.isArray(settings?.settings) ? (settings.settings as unknown[]) : [];
  const values = new Map<string, number | null>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key === 'string') values.set(key, typeof value === 'number' ? value : null);
  }
  return BUDGETS.filter((b) => values.has(b.key)).map((b) => ({
    label: b.label,
    value: b.describe(values.get(b.key) ?? null),
  }));
}
