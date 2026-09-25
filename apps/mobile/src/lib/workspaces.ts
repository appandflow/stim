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
  /** The main checkout path of this app: a worktree maps to its repository root plus the same subdirectory. */
  key: string;
  name: string;
}

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

export function projectOf(env: Pick<EnvironmentState, 'path' | 'worktree'>): ProjectRef {
  const parts = env.path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    const worktreeDir = parts[i] === '.worktrees' || (parts[i] === 'worktrees' && parts[i - 1] === '.claude');
    if (!worktreeDir) continue;
    const rootEnd = parts[i] === '.worktrees' ? i : i - 1;
    const root = parts.slice(0, rootEnd).join('/');
    const subdir = parts.slice(i + 2);
    return { key: [root, ...subdir].join('/'), name: basename(root) };
  }
  const repository = env.worktree?.repository;
  if (repository && env.path.startsWith(`${repository}/`)) return { key: env.path, name: basename(repository) };
  return { key: env.path, name: basename(env.path) };
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
  for (const env of payload.environments) {
    const project = projectOf(env);
    let group = groups.get(project.key);
    if (!group) {
      group = { key: project.key, name: project.name, liveCount: 0, workspaces: [] };
      groups.set(project.key, group);
    }
    if (project.name !== basename(project.key)) group.name = project.name;
    group.workspaces.push(env);
    if (isActive(env)) group.liveCount += 1;
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
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
