import { t } from '@lingui/core/macro';

import type { ArchivedWorkspace } from '@/lib/archived';
import type { Tone } from '@/design/tone';
import { pathInCheckout, projectOf, repositoryRoots, workspaceTitle } from '@/lib/workspace-names';
import { deviceKey, devicesOf, isShownLive, orderDevices, type DeviceRef } from '@/lib/workspaces';
import type {
  DevicePlatform,
  EnvironmentState,
  MachineUsage,
  StatusPayload,
  UsageSample,
  WorktreeFacts,
} from '@/protocol/types';

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

/**
 * Every workspace of every Mac, by project, name and Mac. The order never depends on activity, builds or setup, so
 * a workspace keeps its place; the home screen groups live and idle ones into sections.
 */
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
        title: workspaceTitle(env, roots),
        inCheckout: pathInCheckout(env, roots),
        env,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.title.localeCompare(b.title) || a.macName.localeCompare(b.macName),
  );
}

export interface HomeWorktree {
  key: string;
  macId: string;
  macName: string;
  project: string;
  title: string;
  facts: WorktreeFacts;
}

export interface HomeArchive {
  key: string;
  macId: string;
  macName: string;
  project: string;
  title: string;
  archive: ArchivedWorkspace;
}

export function mergeArchives(macs: MacSnapshot[]): HomeArchive[] {
  return macs.flatMap((mac) =>
    (mac.status?.archived ?? []).map((archive) => ({
      key: `${mac.id}\narchive\n${archive.id}`,
      macId: mac.id,
      macName: mac.name,
      project: archive.project,
      title: archive.worktree.branch || archive.project,
      archive,
    })),
  );
}

export type HomeEntry = HomeItem | HomeWorktree | HomeArchive;

/** The home row an entry belongs to: apps of one linked checkout share a row, so they share a key. */
export function workspaceKey(item: HomeEntry): string {
  if ('facts' in item || 'archive' in item) return item.key;
  const checkout = item.env.worktree?.path;
  return `${item.macId}\n${checkout ? `checkout\n${checkout}` : `app\n${item.env.path}`}`;
}

export function mergeWorktrees(macs: MacSnapshot[]): HomeWorktree[] {
  const items: HomeWorktree[] = [];
  for (const mac of macs) {
    if (!mac.status) continue;
    const roots = repositoryRoots(mac.status);
    const seen = new Set<string>();
    for (const facts of mac.status.unprovisionedWorktrees ?? []) {
      if (seen.has(facts.path)) continue;
      seen.add(facts.path);
      if (
        mac.status.environments.some(
          (env) =>
            env.worktree?.path === facts.path || env.path === facts.path || env.path.startsWith(`${facts.path}/`),
        )
      )
        continue;
      const worktree = { path: facts.path, worktree: facts };
      items.push({
        key: `${mac.id}\nworktree\n${facts.path}`,
        macId: mac.id,
        macName: mac.name,
        project: projectOf(worktree, roots).name,
        title: workspaceTitle(worktree, roots),
        facts,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.title.localeCompare(b.title) || a.macName.localeCompare(b.macName),
  );
}

export type ActivityFilter = 'live' | 'idle' | 'all' | 'archived';

export interface HomeFilters {
  /** Mac ids to show; empty shows every Mac. */
  macs: string[];
  /** Project names to show; empty shows every project. */
  projects: string[];
  activity: ActivityFilter;
  errorsOnly: boolean;
  remoteOnly: boolean;
  platforms: DevicePlatform[];
  buildingOnly: boolean;
  sort: 'recent' | 'name';
}

export const DEFAULT_FILTERS: HomeFilters = {
  macs: [],
  projects: [],
  activity: 'live',
  errorsOnly: false,
  remoteOnly: false,
  platforms: [],
  buildingOnly: false,
  sort: 'recent',
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
    activity:
      saved.activity === 'idle' || saved.activity === 'all' || saved.activity === 'archived' ? saved.activity : 'live',
    errorsOnly: saved.errorsOnly === true,
    remoteOnly: saved.remoteOnly === true,
    platforms: strings(saved.platforms).filter(
      (platform): platform is DevicePlatform =>
        platform === 'ios' || platform === 'android' || platform === 'web' || platform === 'macos',
    ),
    buildingOnly: saved.buildingOnly === true,
    sort: saved.sort === 'name' ? 'name' : 'recent',
  };
}

/** Whether any filter differs from the defaults, for the dot on the filter button. */
export function filtersActive(filters: HomeFilters, macIds: string[], projects: string[]): boolean {
  return (
    filters.macs.some((id) => macIds.includes(id)) ||
    filters.projects.some((name) => projects.includes(name)) ||
    filters.activity !== DEFAULT_FILTERS.activity ||
    filters.errorsOnly ||
    filters.remoteOnly ||
    filters.platforms.length > 0 ||
    filters.buildingOnly
  );
}

const hasErrors = (env: EnvironmentState) => (env.logs?.errorsSinceMarker ?? 0) > 0;
const hasRemote = (env: EnvironmentState) => (env.remoteDevices?.length ?? 0) > 0;

/**
 * The items the filters keep, and how many more the activity filter alone hides. A selected machine that is no
 * longer paired, or a selected project no machine lists any more, is ignored, so it cannot hide everything.
 */
export function filterWorkspaces<T extends HomeEntry>(
  items: T[],
  filters: HomeFilters,
  macIds: string[],
): { shown: T[]; hiddenByActivity: number } {
  const macs = filters.macs.filter((id) => macIds.includes(id));
  const projects = filters.projects.filter((name) => items.some((item) => item.project === name));
  const shown: T[] = [];
  const hidden = new Set<string>();
  for (const item of items) {
    const archived = 'archive' in item;
    if (archived !== (filters.activity === 'archived')) continue;
    if (macs.length && !macs.includes(item.macId)) continue;
    if (projects.length && !projects.includes(item.project)) continue;
    if (
      filters.errorsOnly &&
      !('archive' in item ? item.archive.builds.lastErrorCount > 0 : 'env' in item && hasErrors(item.env))
    )
      continue;
    if (filters.remoteOnly && (!('env' in item) || !hasRemote(item.env))) continue;
    if (
      filters.platforms.length &&
      (!('env' in item) ||
        !(
          devicesOf(item.env).some((device) => filters.platforms.includes(device.platform)) ||
          item.env.remoteDevices?.some((device) => filters.platforms.some((platform) => platform === device.platform))
        ))
    )
      continue;
    if (
      filters.buildingOnly &&
      (!('env' in item) || (item.env.build?.state !== 'running' && item.env.macos?.build.state !== 'running'))
    )
      continue;
    const active = 'env' in item && isShownLive(item.env);
    if ((filters.activity === 'live' && !active) || (filters.activity === 'idle' && active)) {
      hidden.add(workspaceKey(item));
      continue;
    }
    shown.push(item);
  }
  return { shown, hiddenByActivity: hidden.size };
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
 * Every running device the machine, project and platform filters keep, whatever the workspace activity,
 * errors, builds or remote sessions, in the list's order and each workspace's devices in `orderDevices` order.
 */
export function runningDevices(items: HomeItem[], filters: HomeFilters, macIds: string[]): DeviceTileItem[] {
  const { shown } = filterWorkspaces(
    items,
    { ...filters, activity: 'all', errorsOnly: false, remoteOnly: false, buildingOnly: false },
    macIds,
  );
  return shown.flatMap((item) =>
    orderDevices(devicesOf(item.env))
      .filter((device) => device.running && (!filters.platforms.length || filters.platforms.includes(device.platform)))
      .map((device) => ({ key: `${item.key}\n${deviceKey(device)}`, item, device })),
  );
}

export function projectNames(items: HomeEntry[]): string[] {
  return [...new Set(items.map((item) => item.project))].sort((a, b) => a.localeCompare(b));
}

export function workspaceActivityMs(env: EnvironmentState): number | null {
  const stamps = [
    env.supervisor?.startedAt,
    env.build?.startedAt,
    env.build?.phaseStartedAt,
    env.phaseSince,
    ...devicesOf(env).flatMap((device) => [device.activity?.lastActivityAt, device.activity?.driver?.since]),
    ...(env.remoteDevices ?? []).map((device) => device.startedAt),
    ...Object.values(env.lastBuilds ?? {}).map((build) => build?.finishedAt ?? build?.startedAt),
  ];
  let latest: number | null = null;
  for (const stamp of stamps) {
    const ms = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

export function projectsByActivity(items: HomeEntry[]): string[] {
  const activity = new Map<string, number>();
  for (const item of items) {
    const ms = 'env' in item ? workspaceActivityMs(item.env) : null;
    activity.set(item.project, Math.max(activity.get(item.project) ?? -Infinity, ms ?? -Infinity));
  }
  return [...activity.keys()].sort((a, b) => activity.get(b)! - activity.get(a)! || a.localeCompare(b));
}

export function keepProjectOrder(previous: string[], current: string[]): string[] {
  return [
    ...previous.filter((project) => current.includes(project)),
    ...current.filter((project) => !previous.includes(project)).sort((a, b) => a.localeCompare(b)),
  ];
}

export function visibleProjects({
  sorted,
  selected,
  query,
  expanded,
  limit = 6,
}: {
  sorted: string[];
  selected: string[];
  query: string;
  expanded: boolean;
  limit?: number;
}): { projects: string[]; showToggle: boolean } {
  const search = query.trim().toLowerCase();
  const projects = sorted.filter(
    (project, index) =>
      selected.includes(project) || (search ? project.toLowerCase().includes(search) : expanded || index < limit),
  );
  return { projects, showToggle: sorted.length > limit && !search && (expanded || projects.length < sorted.length) };
}

const LOW_DISK_BYTES = 20e9;

/** Binary units labeled GB, like Activity Monitor's memory figures. */
const memoryGb = (bytes: number) => bytes / 2 ** 30;

export type UsageTone = 'normal' | 'warn' | 'critical';

const USAGE_TONE: Record<UsageTone, Tone> = { normal: 'default', warn: 'warning', critical: 'error' };

export const usageTone = (tone: UsageTone): Tone => USAGE_TONE[tone];

export type StatKind = 'cpu' | 'memory' | 'disk';

export interface MachineStat {
  kind: StatKind;
  label: string;
  value: string;
  tone: UsageTone;
}

// Stim Desktop's UsageThresholds holds the same thresholds; both replay desktop/Tests/StimKitTests/Fixtures/usage-tone-vectors.json.
const CPU_WARN_FRACTION = 0.8;
const CPU_CRITICAL_FRACTION = 0.95;
// A quarter of the low-disk warning, so the compact stat also has a red tier before Stim's own hard floor bites.
const DISK_CRITICAL_BYTES = LOW_DISK_BYTES / 4;
const PRESSURE_TONES: UsageTone[] = ['normal', 'warn', 'critical'];

const cpuTone = (fraction: number): UsageTone =>
  fraction >= CPU_CRITICAL_FRACTION ? 'critical' : fraction >= CPU_WARN_FRACTION ? 'warn' : 'normal';
const diskTone = (freeBytes: number): UsageTone =>
  freeBytes < DISK_CRITICAL_BYTES ? 'critical' : freeBytes < LOW_DISK_BYTES ? 'warn' : 'normal';
const pressureTone = (level: number): UsageTone => PRESSURE_TONES[level] ?? 'normal';

/**
 * The chip and sheet's compact stats: CPU busy fraction, the Mac's memory used of total, and the lowest free
 * space of Stim's volumes. A stat is left out when the server or platform cannot report it.
 */
export function machineStats(usage: MachineUsage | null): MachineStat[] {
  if (!usage) return [];
  const stats: MachineStat[] = [];
  const cpuUsage = usage.cpu?.usage;
  if (typeof cpuUsage === 'number') {
    const fraction = cpuUsage;
    const percent = Math.round(fraction * 100);
    stats.push({
      kind: 'cpu',
      label: t`CPU`,
      value: t`${percent}%`,
      tone: cpuTone(fraction),
    });
  }
  const used = usage.memory.usedBytes;
  if (typeof used === 'number') {
    const usedGb = Math.round(memoryGb(used));
    const totalGb = Math.round(memoryGb(usage.memory.totalBytes));
    stats.push({
      kind: 'memory',
      label: t`RAM`,
      value: t`${usedGb}/${totalGb} GB`,
      tone: usage.memory.pressure === 'critical' ? 'critical' : usage.memory.pressure === 'warning' ? 'warn' : 'normal',
    });
  }
  const lowest = usage.volumes.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest !== null) {
    const freeGb = Math.round(lowest / 1e9);
    stats.push({
      kind: 'disk',
      label: t`Disk`,
      value: t`${freeGb} GB free`,
      tone: diskTone(lowest),
    });
  }
  return stats;
}

const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/** Appends the samples newer than the last one held, then drops those outside the history window. */
export function mergeUsageSamples(current: UsageSample[], incoming: UsageSample[]): UsageSample[] {
  const last = current.at(-1)?.at ?? -Infinity;
  const next = [...current, ...incoming.filter((sample) => sample.at > last)];
  const start = (next.at(-1)?.at ?? 0) - HISTORY_WINDOW_MS;
  return next.filter((sample) => sample.at > start);
}

const HISTORY_COLUMNS = 60;
const TONE_RANK: Record<UsageTone, number> = { normal: 0, warn: 1, critical: 2 };

export interface HistoryColumn {
  fraction: number;
  tone: UsageTone;
}

export interface UsageChart {
  kind: StatKind;
  label: string;
  value: string;
  tone: UsageTone;
  /** Oldest first; null where the hour has no sample. */
  columns: (HistoryColumn | null)[];
}

interface Metric {
  kind: StatKind;
  label: string;
  read: (sample: UsageSample) => number | null;
  fraction: (value: number) => number;
  tone: (value: number, sample: UsageSample) => UsageTone;
  format: (value: number) => string;
}

/**
 * The status sheet's charts over the hour ending at the newest sample, which is the Mac's clock rather than the
 * phone's. Each column averages its samples and takes their worst tone. A chart is left out when no sample
 * reports it, or when `usage` lacks the total it is drawn against.
 */
export function usageCharts(samples: UsageSample[], usage: MachineUsage | null): UsageChart[] {
  const end = samples.at(-1)?.at;
  if (end === undefined || !usage) return [];
  const memoryTotal = usage.memory.totalBytes;
  const diskTotal = usage.volumes.find((volume) => volume.mount === '/')?.totalBytes;
  const metrics: Metric[] = [
    {
      kind: 'cpu',
      label: t`CPU`,
      read: (s) => s.cpu,
      fraction: (v) => v,
      tone: cpuTone,
      format: (v) => {
        const percent = Math.round(v * 100);
        return t`${percent}%`;
      },
    },
    {
      kind: 'memory',
      label: t`RAM`,
      read: (s) => s.memoryUsedBytes,
      fraction: (v) => v / memoryTotal,
      tone: (_, s) => pressureTone(s.memoryPressure ?? 0),
      format: (v) => {
        const usedGb = Math.round(memoryGb(v));
        const totalGb = Math.round(memoryGb(memoryTotal));
        return t`${usedGb}/${totalGb} GB`;
      },
    },
    ...(diskTotal
      ? [
          {
            kind: 'disk' as const,
            label: t`Disk free`,
            read: (s: UsageSample) => s.diskFreeBytes,
            fraction: (v: number) => v / diskTotal,
            tone: diskTone,
            format: (v: number) => {
              const gb = Math.round(v / 1e9);
              return t`${gb} GB`;
            },
          },
        ]
      : []),
  ];
  const start = end - HISTORY_WINDOW_MS;
  const width = HISTORY_WINDOW_MS / HISTORY_COLUMNS;
  const charts: UsageChart[] = [];
  for (const metric of metrics) {
    const buckets: { sum: number; count: number; tone: UsageTone }[] = [];
    let latest: { value: number; sample: UsageSample } | null = null;
    for (const sample of samples) {
      const value = metric.read(sample);
      if (value === null || sample.at <= start) continue;
      latest = { value, sample };
      const index = Math.min(HISTORY_COLUMNS - 1, Math.floor((sample.at - start) / width));
      const tone = metric.tone(value, sample);
      const bucket = (buckets[index] ??= { sum: 0, count: 0, tone });
      bucket.sum += value;
      bucket.count += 1;
      if (TONE_RANK[tone] > TONE_RANK[bucket.tone]) bucket.tone = tone;
    }
    if (!latest) continue;
    charts.push({
      kind: metric.kind,
      label: metric.label,
      value: metric.format(latest.value),
      tone: metric.tone(latest.value, latest.sample),
      columns: Array.from({ length: HISTORY_COLUMNS }, (_, i) => {
        const bucket = buckets[i];
        if (!bucket) return null;
        return { fraction: Math.min(1, Math.max(0, metric.fraction(bucket.sum / bucket.count))), tone: bucket.tone };
      }),
    });
  }
  return charts;
}

export interface BudgetRow {
  label: string;
  value: string;
}

const budgets = (): { key: string; label: string; describe: (value: number | null) => string }[] => [
  {
    key: 'budget.minFreeDiskGb',
    label: t`Reclaims disk`,
    describe: (v) => (v ? t`below ${v} GB free` : t`only below the hard floor`),
  },
  {
    key: 'budget.hardFloorDiskGb',
    label: t`Refuses to run`,
    describe: (v) => (v ? t`below ${v} GB free` : t`never`),
  },
  {
    key: 'budget.maxCommittedMemoryGb',
    label: t`Memory budget`,
    describe: (v) => (v === null ? t`60% of memory` : v === 0 ? t`off` : t`${v} GB`),
  },
  { key: 'budget.maxLiveWorkspaces', label: t`Live workspaces`, describe: (v) => (v ? String(v) : t`no limit`) },
];

function settingNumbers(settings: Record<string, unknown> | null): Map<string, number | null> {
  const entries = Array.isArray(settings?.settings) ? (settings.settings as unknown[]) : [];
  const values = new Map<string, number | null>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key === 'string') values.set(key, typeof value === 'number' ? value : null);
  }
  return values;
}

/** The Mac's `budget.minFreeDiskGb`, or null when the payload omits it or sets no positive floor. */
export function minFreeDiskGb(settings: Record<string, unknown> | null): number | null {
  const value = settingNumbers(settings).get('budget.minFreeDiskGb');
  return value != null && value > 0 ? value : null;
}

/** The budget rows of a `stim settings --json` payload; settings the Mac does not list are left out. */
export function budgetRows(settings: Record<string, unknown> | null): BudgetRow[] {
  const values = settingNumbers(settings);
  return budgets()
    .filter((b) => values.has(b.key))
    .map((b) => ({
      label: b.label,
      value: b.describe(values.get(b.key) ?? null),
    }));
}
