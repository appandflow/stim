import type { PillTone } from '@/components/pill';
import { formatSize } from '@/intl/format';
import type { EnvironmentState, MachineOwner, StatusPayload, WorktreeFacts } from '@/protocol/types';
import { pathInCheckout, projectOf, repositoryRoots, workspaceTitle, workspaceTitleAt } from '@/lib/workspaces';

/** The parts of a `stim gc --json` dry run the Machine screen reads. Every field may be absent from an older stim. */
export interface GcReport {
  sections: {
    deadProjects?: { path: string }[];
    orphanedWorkspaces?: { dir: string | null; bytes: number | null }[];
    linkedWorktrees?: {
      path: string;
      idleDays: number | null;
      mergedInto: string | null;
      pullRequest: {
        number: number;
        state: 'open' | 'merged' | 'closed';
        url: string;
        containsHead: boolean;
      } | null;
      willRemove: boolean;
      detail: string | null;
    }[];
    parkedSimulators?: GcDevice[];
    parkedEmulators?: GcDevice[];
    orphanedDevices?: GcDevice[];
    staleDevices?: GcDevice[];
    workspaceLogs?: { projectRoot: string | null; bytes: number; trimBytes: number; willTrim: boolean }[];
    workspaceBuildOutputs?: {
      dir: string | null;
      projectRoot: string | null;
      bytes: number | null;
      idleDays: number | null;
      willClear: boolean;
    }[];
    recordings?: {
      dir: string;
      projectRoot: string | null;
      bytes: number;
      deleteBytes: number;
      willDelete: boolean;
      withWorkspace: boolean;
    }[];
    caches?: { name: string; dir: string; bytes: number | null; note: string | null }[];
  };
  inventory?: {
    devices: InventoryDevice[];
    runtimes: {
      identifier: string;
      runtimeIdentifier: string | null;
      version: string | null;
      build: string | null;
      bytes: number | null;
      deviceCount: number;
    }[];
    systemImages: { package: string; avdCount: number }[];
    notices: string[];
  } | null;
}

interface GcDevice {
  udid?: string;
  id?: string;
  name?: string;
  bytes: number | null;
}

export type InventoryOwner = 'workspace' | 'parked' | 'orphaned' | 'otherStimHome' | 'user';

export interface InventoryDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  model: string | null;
  runtime: string | null;
  lastUsedAt: string | null;
  bytes: number | null;
  owner: InventoryOwner;
  project: string | null;
  slot: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The payload as a report, or null when it is not a gc payload. */
export function parseGcReport(payload: Record<string, unknown> | null | undefined): GcReport | null {
  if (!payload || !isObject(payload.sections)) return null;
  const inventory = payload.inventory;
  const listed =
    isObject(inventory) &&
    Array.isArray(inventory.devices) &&
    Array.isArray(inventory.runtimes) &&
    Array.isArray(inventory.systemImages);
  return {
    sections: payload.sections as GcReport['sections'],
    inventory: listed
      ? ({ ...inventory, notices: Array.isArray(inventory.notices) ? inventory.notices : [] } as GcReport['inventory'])
      : null,
  };
}

/** The sum of the known sizes, and whether every size was known. */
export interface Total {
  bytes: number;
  complete: boolean;
}

function total(sizes: (number | null)[]): Total {
  return {
    bytes: sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0),
    complete: sizes.every((size) => size !== null),
  };
}

function largestFirst<T>(size: (item: T) => number | null, name: (item: T) => string) {
  return (a: T, b: T) => {
    const x = size(a);
    const y = size(b);
    if (x !== null && y !== null && x !== y) return y - x;
    if (x !== null && y === null) return -1;
    if (x === null && y !== null) return 1;
    return name(a).localeCompare(name(b));
  };
}

export interface Chip {
  label: string;
  tone: PillTone;
}

export interface WorktreeRow {
  path: string;
  title: string;
  /** Where the workspace sits inside its checkout, such as `apps/mobile`. */
  inCheckout: string | null;
  lifecycle: Chip | null;
  nodeModules: number | null;
  devices: number | null;
  deviceCount: number;
  /** Stim's build outputs, with the logs when gc did not size them apart. */
  outputs: number | null;
  logs: number | null;
  total: Total | null;
}

export interface RepositoryRow {
  path: string;
  name: string;
  worktrees: WorktreeRow[];
  total: Total | null;
}

export interface DeviceRow {
  id: string;
  kind: 'ios' | 'android';
  name: string;
  subtitle: string;
  owner: Chip;
  stim: boolean;
  bytes: number | null;
}

export interface RuntimeRow {
  id: string;
  title: string;
  detail: string | null;
  bytes: number | null;
  deviceCount: number;
  unused: boolean;
}

export interface FreeRow {
  id: string;
  title: string;
  detail: string;
  bytes: number | null;
  /** The command on the Mac that frees it. */
  command: string;
}

export interface SizedRow {
  id: string;
  title: string;
  detail: string | null;
  bytes: number | null;
}

export type CategoryKey = 'stimDevices' | 'stimOutputs' | 'nodeModules' | 'otherDevices' | 'runtimes';

export interface Category {
  key: CategoryKey;
  title: string;
  total: Total;
}

export interface MachineReport {
  categories: Category[];
  free: FreeRow[];
  freeTotal: Total;
  repositories: RepositoryRow[];
  devices: DeviceRow[];
  /** Whether `devices` is gc's full inventory rather than the status's Stim-owned devices only. */
  inventory: boolean;
  notices: string[];
  runtimes: RuntimeRow[];
  recordings: SizedRow[];
  caches: SizedRow[];
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-0" reads "iOS 27.0". */
function iosRuntimeTitle(identifier: string): string {
  const last = identifier.split('.').pop() ?? identifier;
  const [platform, ...version] = last.split('-');
  return version.length ? `${platform} ${version.join('.')}` : last;
}

/** "system-images;android-36;google_apis;arm64-v8a" reads "Android 36 \u00B7 google_apis". */
function systemImageTitle(pkg: string): string {
  const parts = pkg.split(';');
  if (parts.length < 3 || !parts[1]!.startsWith('android-')) return pkg;
  return `Android ${parts[1]!.slice('android-'.length)} \u00B7 ${parts[2]}`;
}

/** Hours or days since `iso`, from `now`. */
export function agoLabel(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function lifecycle(
  worktree: NonNullable<GcReport['sections']['linkedWorktrees']>[number] | undefined,
  facts: WorktreeFacts | null | undefined,
  missing: boolean,
  unprovisioned: boolean,
): Chip | null {
  if (missing) return { label: 'Folder gone', tone: 'warning' };
  if (worktree?.mergedInto)
    return { label: `Merged into ${worktree.mergedInto.replace(/^origin\//, '')}`, tone: 'success' };
  const pull = worktree?.pullRequest ?? null;
  if (pull?.state === 'merged' && pull.containsHead) return { label: `PR #${pull.number} merged`, tone: 'success' };
  const open =
    pull?.state === 'open'
      ? pull
      : facts?.pullRequest?.state === 'open' || facts?.pullRequest?.state === 'draft'
        ? facts.pullRequest
        : null;
  if (open) return { label: `PR #${open.number} open`, tone: 'info' };
  if (unprovisioned) return { label: 'Not warmed', tone: 'neutral' };
  if (worktree?.idleDays != null && worktree.idleDays >= STALE_DAYS) {
    return { label: `Stale ${worktree.idleDays}d`, tone: 'warning' };
  }
  return null;
}

const STALE_DAYS = 7;

function statusDeviceSizes(env: EnvironmentState): { kind: 'ios' | 'android'; name: string | null; bytes: number }[] {
  const slots = [env, ...(env.slots ?? [])];
  const sizes: { kind: 'ios' | 'android'; name: string | null; bytes: number }[] = [];
  for (const slot of slots) {
    if (slot.ios?.owned && slot.ios.disk) sizes.push({ kind: 'ios', name: slot.ios.udid, bytes: slot.ios.disk.bytes });
    if (slot.android?.owned && !slot.android.physical && slot.android.disk) {
      sizes.push({ kind: 'android', name: slot.android.name ?? null, bytes: slot.android.disk.bytes });
    }
  }
  return sizes;
}

function ownerChip(device: InventoryDevice, status: StatusPayload | null): Chip {
  switch (device.owner) {
    case 'workspace': {
      const name = device.project ? workspaceTitleAt(device.project, status) : 'a workspace';
      const slot = device.slot && device.slot !== 'default' ? ` (${device.slot})` : '';
      return { label: `Stim \u00B7 ${name}${slot}`, tone: 'accent' };
    }
    case 'parked':
      return { label: 'Stim \u00B7 parked', tone: 'accent' };
    case 'orphaned':
      return { label: 'Stim \u00B7 no workspace', tone: 'warning' };
    case 'otherStimHome':
      return { label: 'Another Stim home', tone: 'neutral' };
    default:
      return { label: 'Yours', tone: 'neutral' };
  }
}

const STIM_OWNERS: InventoryOwner[] = ['workspace', 'parked', 'orphaned'];

/**
 * Stim Desktop's Machine page (apps/desktop StorageReport) from what the phone can read: the status payload, and
 * the `machine.details` gc dry run when the server has it. Desktop also sizes AVDs, system images and other tools
 * with `du`; the phone takes an AVD's size from the status's owned-emulator measurement and leaves the rest unsized.
 */
export function machineReport(status: StatusPayload | null, gc: GcReport | null, now: number): MachineReport {
  const s = gc?.sections ?? {};
  const environments = status?.environments ?? [];
  const roots = status ? repositoryRoots(status) : [];
  const envDeviceSizes = new Map<string, number>();
  for (const env of environments) {
    for (const { name, bytes } of statusDeviceSizes(env)) if (name) envDeviceSizes.set(name, bytes);
  }

  const inventory = gc?.inventory ?? null;
  const devices: DeviceRow[] = inventory
    ? inventory.devices.map((device) => ({
        id: `${device.kind}:${device.id}`,
        kind: device.kind,
        name: device.name,
        subtitle: [
          STIM_OWNERS.includes(device.owner) || device.owner === 'otherStimHome' ? device.model : null,
          device.runtime
            ? device.kind === 'ios'
              ? iosRuntimeTitle(device.runtime)
              : systemImageTitle(device.runtime)
            : null,
          device.lastUsedAt ? `used ${agoLabel(device.lastUsedAt, now)}` : null,
        ]
          .filter(Boolean)
          .join(' \u00B7 '),
        owner: ownerChip(device, status),
        stim: STIM_OWNERS.includes(device.owner),
        bytes: device.bytes ?? envDeviceSizes.get(device.id) ?? null,
      }))
    : environments.flatMap((env) =>
        statusDeviceSizes(env).map(({ kind, name, bytes }) => ({
          id: `${env.path}:${name}`,
          kind,
          name: name ?? 'Device',
          subtitle: '',
          owner: { label: `Stim \u00B7 ${workspaceTitle(env, roots)}`, tone: 'accent' as const },
          stim: true,
          bytes,
        })),
      );
  devices.sort(
    largestFirst(
      (d) => d.bytes,
      (d) => d.name,
    ),
  );

  const outputs = new Map((s.workspaceBuildOutputs ?? []).flatMap((o) => (o.projectRoot ? [[o.projectRoot, o]] : [])));
  const logs = new Map((s.workspaceLogs ?? []).flatMap((l) => (l.projectRoot ? [[l.projectRoot, l]] : [])));
  const linked = new Map((s.linkedWorktrees ?? []).map((w) => [w.path, w]));
  const dead = new Set((s.deadProjects ?? []).map((p) => p.path));

  const rows: (WorktreeRow & { root: string; repository: string })[] = environments.map((env) => {
    const root = env.worktree?.path ?? env.path;
    const own = inventory
      ? devices.filter((d) => {
          const source = inventory.devices.find((i) => `${i.kind}:${i.id}` === d.id);
          return source?.owner === 'workspace' && source.project === env.path;
        })
      : devices.filter((d) => d.id.startsWith(`${env.path}:`));
    const deviceBytes = own.length ? total(own.map((d) => d.bytes)) : null;
    const output = outputs.get(env.path);
    const log = logs.get(env.path);
    const nodeModules = env.disk?.nodeModulesBytes ?? null;
    const outputBytes = gc ? (output ? output.bytes : 0) : (env.disk?.buildBytes ?? null);
    const logBytes = gc ? (log?.bytes ?? 0) : null;
    const parts = [nodeModules, deviceBytes?.bytes ?? 0, outputBytes];
    if (gc) parts.push(logBytes);
    const known = parts.some((part) => part !== null && part > 0);
    const sized = total(parts);
    return {
      path: env.path,
      root,
      repository: projectOf(env, roots).key,
      title: workspaceTitle(env, roots),
      inCheckout: pathInCheckout(env, roots),
      lifecycle: lifecycle(linked.get(root), env.worktree, dead.has(env.path), false),
      nodeModules,
      devices: deviceBytes?.bytes ?? null,
      deviceCount: own.length,
      outputs: outputBytes,
      logs: logBytes,
      total: known ? { bytes: sized.bytes, complete: sized.complete && (deviceBytes?.complete ?? true) } : null,
    };
  });
  const listed = new Set(rows.map((row) => row.root));
  for (const tree of status?.unprovisionedWorktrees ?? []) {
    if (listed.has(tree.path)) continue;
    const env = { path: tree.path, worktree: tree };
    rows.push({
      path: tree.path,
      root: tree.path,
      repository: projectOf(env, roots).key,
      title: workspaceTitle(env, roots),
      inCheckout: null,
      lifecycle: lifecycle(linked.get(tree.path), tree, false, true),
      nodeModules: null,
      devices: null,
      deviceCount: 0,
      outputs: null,
      logs: null,
      total: null,
    });
  }
  const byTotal = largestFirst<{ total: Total | null; path: string }>(
    (row) => row.total?.bytes ?? null,
    (row) => row.path,
  );
  const rootModules = (root: string): number | null => {
    const measured = rows.flatMap((row) => (row.root === root && row.nodeModules !== null ? [row.nodeModules] : []));
    return measured.length ? Math.min(...measured) : null;
  };
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.repository, [...(grouped.get(row.repository) ?? []), row]);
  const repositories: RepositoryRow[] = [...grouped].map(([path, members]) => {
    const seen = new Set<string>();
    const totals = members.flatMap((row) => {
      if (!row.total) return [];
      const shared = seen.has(row.root);
      seen.add(row.root);
      return [
        {
          bytes: row.total.bytes - (shared && row.nodeModules !== null ? (rootModules(row.root) ?? 0) : 0),
          complete: row.total.complete,
        },
      ];
    });
    return {
      path,
      name: path.split('/').filter(Boolean).pop() ?? path,
      worktrees: members.map(({ root: _root, repository: _repository, ...row }) => row).sort(byTotal),
      total: totals.length
        ? { bytes: totals.reduce((sum, t) => sum + t.bytes, 0), complete: totals.every((t) => t.complete) }
        : null,
    };
  });
  repositories.sort(byTotal);

  const free: FreeRow[] = [];
  const gcDevices = (list: GcDevice[] | undefined, detail: string) => {
    for (const device of list ?? []) {
      const id = device.udid ?? device.id ?? device.name ?? '?';
      free.push({
        id: `device:${id}`,
        title: device.name ?? id,
        detail,
        bytes: device.bytes,
        command: 'stim gc --delete',
      });
    }
  };
  gcDevices(s.parkedSimulators, 'Parked simulator, kept for reuse');
  gcDevices(s.parkedEmulators, 'Parked emulator, kept for reuse');
  gcDevices(s.orphanedDevices, 'Created by this Stim home; no workspace uses it');
  gcDevices(s.staleDevices, 'Its workspace has not been used for a while');
  for (const dir of s.orphanedWorkspaces ?? []) {
    free.push({
      id: `workspace:${dir.dir ?? '?'}`,
      title: 'Data of a removed workspace',
      detail: dir.dir ?? 'Stim workspace directory',
      bytes: dir.bytes,
      command: 'stim gc --delete',
    });
  }
  for (const project of s.deadProjects ?? []) {
    free.push({
      id: `project:${project.path}`,
      title: 'Record of a deleted folder',
      detail: `${project.path} is gone`,
      bytes: null,
      command: 'stim gc --delete',
    });
  }
  for (const log of s.workspaceLogs ?? []) {
    if (!log.willTrim) continue;
    free.push({
      id: `logs:${log.projectRoot ?? '?'}`,
      title: `Logs of ${log.projectRoot ? workspaceTitleAt(log.projectRoot, status) : 'a workspace'}`,
      detail: 'Over the cap; each log keeps its newest 8 MiB',
      bytes: log.trimBytes,
      command: 'stim gc --delete',
    });
  }
  for (const output of s.workspaceBuildOutputs ?? []) {
    if (!output.willClear) continue;
    free.push({
      id: `outputs:${output.projectRoot ?? output.dir ?? '?'}`,
      title: `Build outputs of ${output.projectRoot ? workspaceTitleAt(output.projectRoot, status) : 'a workspace'}`,
      detail: output.idleDays
        ? `Not used for ${output.idleDays} days; rebuilt on the next run`
        : 'Not in use; rebuilt on the next run',
      bytes: output.bytes,
      command: 'stim gc --delete --cache workspaces',
    });
  }
  for (const worktree of s.linkedWorktrees ?? []) {
    const pull = worktree.pullRequest;
    const finished = !!pull?.containsHead && (pull.state === 'merged' || pull.state === 'closed');
    if (!worktree.willRemove || (!worktree.mergedInto && !finished)) continue;
    const row = rows.find((r) => r.root === worktree.path);
    free.push({
      id: `worktree:${worktree.path}`,
      title: `Worktree ${row?.title ?? worktree.path.split('/').pop()}`,
      detail: worktree.mergedInto
        ? `Merged into ${worktree.mergedInto.replace(/^origin\//, '')}`
        : 'Its pull request is finished',
      bytes: row?.nodeModules ?? null,
      command: 'stim worktree remove',
    });
  }
  free.sort(
    largestFirst(
      (row) => row.bytes,
      (row) => row.id,
    ),
  );

  const runtimes: RuntimeRow[] = [
    ...(inventory?.runtimes ?? []).map((runtime) => ({
      id: runtime.identifier,
      title: runtime.version
        ? `iOS ${runtime.version}`
        : iosRuntimeTitle(runtime.runtimeIdentifier ?? runtime.identifier),
      detail: runtime.build,
      bytes: runtime.bytes,
      deviceCount: runtime.deviceCount,
      unused: runtime.deviceCount === 0,
    })),
    ...(inventory?.systemImages ?? []).map((image) => ({
      id: image.package,
      title: systemImageTitle(image.package),
      detail: image.package.split(';').pop() ?? null,
      bytes: null,
      deviceCount: image.avdCount,
      unused: image.avdCount === 0,
    })),
  ];
  runtimes.sort((a, b) =>
    a.unused !== b.unused
      ? a.unused
        ? -1
        : 1
      : largestFirst<RuntimeRow>(
          (r) => r.bytes,
          (r) => r.title,
        )(a, b),
  );

  const allCaches = s.caches ?? [];
  const caches: SizedRow[] = allCaches
    .map((cache) => ({
      id: cache.dir,
      title: allCaches.some((other) => other.dir !== cache.dir && other.name === cache.name)
        ? `${cache.name}: ${cache.dir.split('/').pop()}`
        : cache.name,
      detail: cache.note,
      bytes: cache.bytes,
    }))
    .sort(
      largestFirst(
        (row) => row.bytes,
        (row) => row.title,
      ),
    );

  const recordings: SizedRow[] = (s.recordings ?? [])
    .map((recording) => ({
      id: recording.dir,
      title: recording.projectRoot ? workspaceTitleAt(recording.projectRoot, status) : 'A removed workspace',
      detail: recording.withWorkspace
        ? 'Its workspace was removed; stim gc --delete deletes it with the workspace data'
        : null,
      bytes: recording.bytes,
    }))
    .sort(
      largestFirst(
        (row) => row.bytes,
        (row) => row.title,
      ),
    );

  const modules = [...new Set(rows.map((row) => row.root))].map((root) => rootModules(root));
  const stimOutputs = gc
    ? [
        ...allCaches.map((cache) => cache.bytes),
        ...(s.workspaceBuildOutputs ?? []).map((o) => o.bytes),
        ...(s.workspaceLogs ?? []).map((l) => l.bytes),
        ...(s.recordings ?? [])
          .filter((r) => !(s.orphanedWorkspaces ?? []).some((o) => o.dir && r.dir.startsWith(`${o.dir}/`)))
          .map((r) => r.bytes),
        ...(s.orphanedWorkspaces ?? []).map((o) => o.bytes),
      ]
    : environments.map((env) => env.disk?.buildBytes ?? null);
  const inventoried = (sizes: (number | null)[]) => (inventory ? total(sizes) : { bytes: 0, complete: false });
  const categories: Category[] = [
    { key: 'stimDevices', title: 'Stim devices', total: total(devices.filter((d) => d.stim).map((d) => d.bytes)) },
    { key: 'stimOutputs', title: 'Stim caches and outputs', total: total(stimOutputs) },
    { key: 'nodeModules', title: 'node_modules', total: total(modules) },
    {
      key: 'otherDevices',
      title: 'Other simulators and AVDs',
      total: inventoried(devices.filter((d) => !d.stim).map((d) => d.bytes)),
    },
    { key: 'runtimes', title: 'Runtimes and system images', total: inventoried(runtimes.map((r) => r.bytes)) },
  ];

  return {
    categories,
    free,
    freeTotal: total(free.map((row) => row.bytes)),
    repositories,
    devices,
    inventory: inventory !== null,
    notices: inventory?.notices ?? [],
    runtimes,
    recordings,
    caches,
  };
}

/** The owners by memory, then CPU, as Stim Desktop's Now band ranks them. */
export function rankedOwners(owners: readonly MachineOwner[]): MachineOwner[] {
  return [...owners].sort(
    (a, b) => b.memoryMb - a.memoryMb || b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name),
  );
}

/** Build totals per platform from a `stim stats --json` payload's `machine` section. */
export interface BuildStatsRow {
  platform: 'ios' | 'android';
  runs: number;
  failed: number;
  hitRate: number | null;
  timeSavedMs: number | null;
}

export function buildStats(stats: Record<string, unknown> | null | undefined): BuildStatsRow[] {
  const machine = stats && isObject(stats.machine) ? stats.machine : null;
  if (!machine) return [];
  return (['ios', 'android'] as const).flatMap((platform) => {
    const entry = machine[platform];
    if (!isObject(entry) || typeof entry.runs !== 'number') return [];
    const hits = typeof entry.hits === 'number' ? entry.hits : 0;
    const misses = typeof entry.misses === 'number' ? entry.misses : 0;
    return [
      {
        platform,
        runs: entry.runs,
        failed: typeof entry.failed === 'number' ? entry.failed : 0,
        hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
        timeSavedMs: typeof entry.timeSavedMs === 'number' ? entry.timeSavedMs : null,
      },
    ];
  });
}

/** A size, marked as a lower bound when part of it is unsized, or a dash when nothing is. */
export function sizeLabel(size: number | null | Total): string {
  if (size === null) return '\u2014';
  if (typeof size === 'number') return formatSize(size);
  if (size.complete) return formatSize(size.bytes);
  return size.bytes > 0 ? `\u2265 ${formatSize(size.bytes)}` : '\u2014';
}
