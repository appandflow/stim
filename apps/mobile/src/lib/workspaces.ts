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

export interface ProjectGroup {
  key: string;
  name: string;
  liveCount: number;
  workspaces: EnvironmentState[];
}

/** Projects with live workspaces first, then by name; live workspaces first inside each. */
export function groupByProject(payload: StatusPayload): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const roots = repositoryRoots(payload);
  for (const env of payload.environments) {
    const project = projectOf(env, roots);
    let group = groups.get(project.key);
    if (!group) {
      group = { key: project.key, name: project.name, liveCount: 0, workspaces: [] };
      groups.set(project.key, group);
    }
    group.workspaces.push(env);
    if (isActive(env)) group.liveCount += 1;
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const named = new Map<string, number>();
  for (const group of groups.values()) named.set(group.name, (named.get(group.name) ?? 0) + 1);
  for (const group of groups.values()) {
    if ((named.get(group.name) ?? 0) > 1) group.name = group.key.split('/').filter(Boolean).slice(-2).join('/');
  }
  for (const group of groups.values()) {
    group.workspaces.sort(
      (a, b) =>
        Number(isActive(b)) - Number(isActive(a)) || byName(workspaceNames(a.path).title, workspaceNames(b.path).title),
    );
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.liveCount > 0) - Number(a.liveCount > 0) || byName(a.name, b.name),
  );
}

export function isActive(env: EnvironmentState): boolean {
  return env.live || env.build?.state === 'running' || (env.remoteDevices?.length ?? 0) > 0;
}

export interface DeviceRef {
  platform: Platform;
  slot: string;
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

export function runningBuild(env: EnvironmentState, device?: Pick<DeviceRef, 'platform' | 'slot'>): BuildReport | null {
  const build = env.build;
  if (!build || build.state !== 'running') return null;
  if (device && (build.platform !== device.platform || build.slot !== device.slot)) return null;
  return build;
}
