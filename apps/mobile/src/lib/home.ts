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

export interface MacUsageSummary {
  parts: string[];
  tone: UsageTone;
}

/**
 * The chip line: live workspaces, the Mac's memory used of total, and the lowest free space of Stim's volumes.
 * A server older than `memory.usedBytes` leaves the memory figure out.
 */
export function macUsageSummary(status: StatusPayload | null, usage: MachineUsage | null): MacUsageSummary {
  const parts: string[] = [];
  let tone: UsageTone = 'normal';
  if (status) parts.push(`${status.capacity.liveCount} live`);
  const used = usage?.memory.usedBytes;
  if (usage && typeof used === 'number') {
    parts.push(`${memoryGb(used).toFixed(1)}/${Math.round(memoryGb(usage.memory.totalBytes))} GB`);
    if (usage.memory.pressure === 'critical') tone = 'critical';
    else if (usage.memory.pressure === 'warning') tone = 'warn';
  }
  const lowest = usage?.volumes.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest !== null && lowest !== undefined) {
    parts.push(`${formatBytes(lowest)} free`);
    if (lowest < LOW_DISK_BYTES && tone === 'normal') tone = 'warn';
  }
  return { parts, tone };
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
