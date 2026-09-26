import type { EnvironmentState, StatusPayload } from '@stim-cli/core/state';
import type { MachineVolume, PushEvent } from './protocol.ts';

/**
 * The attention items a push can report, computed like the phone's home attention strip
 * (apps/mobile/src/lib/attention.ts, `homeAttention`).
 */
export interface AttentionCandidate {
  /** `disk`, or `<workspace path>\n<item>` as the phone keys the same item after its machine id. */
  key: string;
  event: PushEvent;
  /** Changes when the same item describes a new problem, such as a later failed build. */
  occurrence: string;
  title: string;
  reason: string;
  /** Null for the machine; a workspace item names its workspace, and `logs` opens its logs with Errors only. */
  target: { kind: 'machine' } | { kind: 'workspace' | 'logs'; path: string };
  /** Whether a device of the workspace is driven by an agent; null for a machine item. */
  driven: boolean | null;
  /** The workspace's errors since the last log marker, for `log-errors`. */
  count?: number;
}

const OVERRUN_FACTOR = 2;
const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;
const LOW_DISK_BYTES = 20e9;
const DISK_CRITICAL_BYTES = LOW_DISK_BYTES / 4;

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : 'Android');
const basename = (path: string) => path.split('/').findLast(Boolean) ?? path;

function clockDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  const gb = bytes / 1e9;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function worktreeRoot(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees') return parts.slice(0, i).join('/');
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude') return parts.slice(0, i - 1).join('/');
  }
  return null;
}

function markedCheckout(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees' || (parts[i] === 'worktrees' && parts[i - 1] === '.claude')) {
      return parts.slice(0, i + 2).join('/');
    }
  }
  return null;
}

function repositoryRoots(payload: StatusPayload): string[] {
  const roots = new Set<string>();
  for (const { path, worktree } of payload.environments) roots.add(worktreeRoot(path) ?? worktree?.repository ?? path);
  for (const { path, repository } of payload.unprovisionedWorktrees ?? []) {
    const root = worktreeRoot(path) ?? repository;
    if (root) roots.add(root);
  }
  return [...roots];
}

function workspaceTitle(env: EnvironmentState, roots: string[]): string {
  if (env.worktree?.branch) return env.worktree.branch;
  const checkout = env.worktree?.path ?? markedCheckout(env.path);
  if (checkout) return basename(checkout);
  const own = worktreeRoot(env.path) ?? env.worktree?.repository;
  const root =
    own ??
    roots
      .filter((r) => env.path === r || env.path.startsWith(`${r}/`))
      .reduce<string | null>((best, r) => (best === null || r.length < best.length ? r : best), null) ??
    env.path;
  return basename(root);
}

interface Device {
  platform: 'ios' | 'android';
  slot: string;
  model: string;
  running: boolean;
  driven: boolean;
  appStopped: boolean;
}

function devicesOf(env: EnvironmentState): Device[] {
  const out: Device[] = [];
  const add = (slot: string, ios?: EnvironmentState['ios'], android?: EnvironmentState['android']) => {
    if (ios) {
      out.push({
        platform: 'ios',
        slot,
        model: /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(ios.name ?? '')?.[1] ?? 'iOS Simulator',
        running: ios.state === 'Booted',
        driven: ios.activity?.state === 'driven',
        appStopped: ios.app?.state === 'stopped',
      });
    }
    if (android) {
      out.push({
        platform: 'android',
        slot,
        model: android.physical ? 'Android device' : 'Android Emulator',
        running: android.state === 'detected',
        driven: android.activity?.state === 'driven',
        appStopped: android.app?.state === 'stopped',
      });
    }
  };
  add('default', env.ios, env.android);
  for (const slot of env.slots ?? []) add(slot.slot, slot.ios, slot.android);
  return out;
}

function runningBuild(env: EnvironmentState, device?: Pick<Device, 'platform' | 'slot'>) {
  const build = env.build;
  if (!build || build.state !== 'running') return null;
  if (device && (build.platform !== device.platform || build.slot !== device.slot)) return null;
  return build;
}

const isActive = (env: EnvironmentState) =>
  env.live || env.build?.state === 'running' || (env.remoteDevices?.length ?? 0) > 0;

function workspaceCandidates(env: EnvironmentState, title: string, now: number): AttentionCandidate[] {
  const items: AttentionCandidate[] = [];
  const active = isActive(env);
  const devices = devicesOf(env);
  const driven = devices.some((device) => device.driven);
  const add = (id: string, event: PushEvent, occurrence: string, reason: string, extra: Partial<AttentionCandidate>) =>
    items.push({
      key: `${env.path}\n${id}`,
      event,
      occurrence,
      title,
      reason,
      target: { kind: 'workspace', path: env.path },
      driven,
      ...extra,
    });

  for (const platform of ['ios', 'android'] as const) {
    const last = env.lastBuilds?.[platform];
    if (!last || last.status !== 'failed' || runningBuild(env)?.platform === platform) continue;
    const endedAt = last.finishedAt ?? last.startedAt;
    const ended = Date.parse(endedAt);
    if (!active && !(now - ended < RECENT_FAILURE_MS)) continue;
    const code = last.errorCode ? ` (${last.errorCode})` : '';
    add(`build-${platform}`, 'build-failed', endedAt, `${platformName(platform)} build failed${code}`, {});
  }

  const errors = env.logs?.errorsSinceMarker ?? 0;
  if (active && errors > 0) {
    add('logs', 'log-errors', String(errors), `${errors === 1 ? '1 error' : `${errors} errors`} in the logs`, {
      target: { kind: 'logs', path: env.path },
      count: errors,
    });
  }

  const build = runningBuild(env);
  const started = build ? Date.parse(build.startedAt) : NaN;
  if (build?.expectedMs && Number.isFinite(started) && now - started > OVERRUN_FACTOR * build.expectedMs) {
    add(
      'overrun',
      'slow-build',
      build.startedAt,
      `${platformName(build.platform)} build at ${clockDuration(now - started)}, usually ~${clockDuration(build.expectedMs)}`,
      {},
    );
  }

  if (env.live) {
    for (const device of devices) {
      if (!device.running || !device.appStopped || runningBuild(env, device)) continue;
      add(`app-${device.platform}-${device.slot}`, 'app-stopped', '', `App not running on ${device.model}`, {});
    }
  }
  return items;
}

/**
 * The machine's disk item and each workspace's failed builds, log errors, build overrun and stopped apps, with
 * the phone strip's rules: an idle workspace reports only a build that failed in the last day.
 */
export function attentionCandidates(
  status: StatusPayload,
  volumes: MachineVolume[] | null,
  name: string,
  now: number,
): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];
  const lowest = volumes?.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest !== null && lowest !== undefined && lowest < DISK_CRITICAL_BYTES) {
    candidates.push({
      key: 'disk',
      event: 'disk',
      occurrence: '',
      title: name,
      reason: `${formatBytes(lowest)} free, below Stim's floor`,
      target: { kind: 'machine' },
      driven: null,
    });
  }
  const roots = repositoryRoots(status);
  for (const env of status.environments) {
    candidates.push(...workspaceCandidates(env, workspaceTitle(env, roots), now));
  }
  return candidates;
}
