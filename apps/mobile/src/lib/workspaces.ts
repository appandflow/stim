import type {
  AndroidState,
  BuildReport,
  DeviceActivity,
  EnvironmentState,
  Platform,
  SimState,
  StatusPayload,
} from '@/protocol/types';

export interface WorkspaceNames {
  title: string;
  subtitle: string;
}

/** Same naming as apps/desktop PathNames: a worktree is named after its folder under `.worktrees`/`worktrees`. */
export function workspaceNames(path: string): WorkspaceNames {
  const parts = path.split('/').filter(Boolean);
  for (const marker of ['.worktrees', 'worktrees']) {
    const i = parts.lastIndexOf(marker);
    if (i >= 0 && i + 1 < parts.length) {
      const name = parts[i + 1];
      const last = parts[parts.length - 1];
      return { title: name, subtitle: last === name ? (i > 0 ? parts[i - 1] : '') : last };
    }
  }
  return { title: parts[parts.length - 1] ?? path, subtitle: parts.length > 1 ? parts[parts.length - 2] : '' };
}

export interface ProjectRef {
  /** The repository root, like apps/desktop, which asks git for the common directory. */
  key: string;
  name: string;
}

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** The repository a `.worktrees/<name>` or `.claude/worktrees/<name>` checkout belongs to. */
function worktreeRoot(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees') return parts.slice(0, i).join('/');
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude') return parts.slice(0, i - 1).join('/');
  }
  return null;
}

/** The parents of the payload's worktrees, and every other checkout, which can hold a nested app. */
export function repositoryRoots(payload: Pick<StatusPayload, 'environments' | 'unprovisionedWorktrees'>): string[] {
  const roots = new Set<string>();
  for (const { path, worktree } of payload.environments) {
    roots.add(worktreeRoot(path) ?? worktree?.repository ?? path);
  }
  for (const { path } of payload.unprovisionedWorktrees ?? []) {
    const root = worktreeRoot(path);
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * The phone cannot run git, so a checkout joins the outermost known root that contains it, and is its
 * own project otherwise.
 */
export function projectOf(env: Pick<EnvironmentState, 'path' | 'worktree'>, roots: string[]): ProjectRef {
  const own = worktreeRoot(env.path) ?? env.worktree?.repository;
  const root =
    own ??
    roots
      .filter((r) => env.path === r || env.path.startsWith(`${r}/`))
      .reduce<string | null>((best, r) => (best === null || r.length < best.length ? r : best), null) ??
    env.path;
  return { key: root, name: basename(root) };
}

/** Where the workspace sits inside its checkout, such as `apps/tlon-mobile`; null at the checkout root. */
export function pathInCheckout(env: Pick<EnvironmentState, 'path' | 'worktree'>, roots: string[]): string | null {
  const parts = env.path.split('/');
  let checkout: string | null = null;
  for (let i = parts.length - 2; i > 0 && checkout === null; i--) {
    if (parts[i] === '.worktrees' || (parts[i] === 'worktrees' && parts[i - 1] === '.claude')) {
      checkout = parts.slice(0, i + 2).join('/');
    }
  }
  checkout ??= env.worktree?.path ?? projectOf(env, roots).key;
  return env.path.startsWith(`${checkout}/`) ? env.path.slice(checkout.length + 1) : null;
}

export function isActive(env: EnvironmentState): boolean {
  return env.live || env.build?.state === 'running' || (env.remoteDevices?.length ?? 0) > 0;
}

export interface DeviceRef {
  platform: Platform;
  slot: string;
  id: string | null;
  name: string;
  model: string;
  state: string;
  running: boolean;
  owned: boolean;
  physical: boolean;
  activity?: DeviceActivity;
}

function iosDevice(slot: string, sim: SimState): DeviceRef {
  const model = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(sim.name ?? '')?.[1] ?? 'iOS Simulator';
  return {
    platform: 'ios',
    slot,
    id: sim.udid,
    name: sim.name ?? sim.udid,
    model,
    state: sim.state,
    running: sim.state === 'Booted',
    owned: sim.owned,
    physical: false,
    activity: sim.activity,
  };
}

function androidDevice(slot: string, avd: AndroidState): DeviceRef {
  return {
    platform: 'android',
    slot,
    id: avd.serial ?? null,
    name: avd.name ?? avd.serial ?? 'Android device',
    model: avd.physical ? 'Android device' : 'Android Emulator',
    state: avd.state ?? 'unknown',
    running: avd.state === 'detected',
    owned: avd.owned,
    physical: avd.physical,
    activity: avd.activity,
  };
}

export function devicesOf(env: EnvironmentState): DeviceRef[] {
  const out: DeviceRef[] = [];
  const add = (slot: string, ios?: SimState | null, android?: AndroidState | null) => {
    if (ios) out.push(iosDevice(slot, ios));
    if (android) out.push(androidDevice(slot, android));
  };
  add('default', env.ios, env.android);
  for (const slot of env.slots ?? []) add(slot.slot, slot.ios, slot.android);
  return out;
}

export function livePlatforms(env: EnvironmentState): Platform[] {
  return [
    ...new Set(
      devicesOf(env)
        .filter((d) => d.running && d.owned && !d.physical)
        .map((d) => d.platform),
    ),
  ];
}

export function runningBuild(env: EnvironmentState, device?: Pick<DeviceRef, 'platform' | 'slot'>): BuildReport | null {
  const build = env.build;
  if (!build || build.state !== 'running') return null;
  if (device && (build.platform !== device.platform || build.slot !== device.slot)) return null;
  return build;
}

const deviceRank = (d: DeviceRef) => (d.running ? (d.activity?.state === 'driven' ? 0 : 1) : 2);

/** Driven devices first, then other running ones, then stopped ones; by slot name inside each group. */
export function orderDevices(devices: DeviceRef[]): DeviceRef[] {
  return [...devices].sort(
    (a, b) => deviceRank(a) - deviceRank(b) || a.slot.localeCompare(b.slot) || a.platform.localeCompare(b.platform),
  );
}

/**
 * Attaches each warning to the device whose name it mentions, the longest name winning so an AVD named after
 * another (`stim-app` and `stim-app-ipad`) keeps its own warnings. Warnings that name no device stay general.
 */
export function deviceWarnings(
  warnings: string[],
  devices: DeviceRef[],
): { byDevice: Map<DeviceRef, string[]>; general: string[] } {
  const byDevice = new Map<DeviceRef, string[]>();
  const general: string[] = [];
  for (const warning of warnings) {
    const device = devices
      .filter((d) => d.name && warning.includes(d.name))
      .reduce<DeviceRef | null>((best, d) => (best === null || d.name.length > best.name.length ? d : best), null);
    if (device) byDevice.set(device, [...(byDevice.get(device) ?? []), warning]);
    else general.push(warning);
  }
  return { byDevice, general };
}
