import type {
  AppPresence,
  BuildCause,
  BuildHistoryEntry,
  ChecksState,
  EnvironmentState,
  GitChip,
  GitChipPart,
  LastBuildReport,
  StatsPlatform,
  WorkspaceStage,
  WorktreeFacts,
} from './status.ts';

type DeviceRecord = NonNullable<EnvironmentState['ios']> | NonNullable<EnvironmentState['android']>;

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];

function isRunning(platform: StatsPlatform, device: DeviceRecord): boolean {
  if (platform === 'ios') return device.state === 'Booted';
  return device.state === 'detected' && !(device as NonNullable<EnvironmentState['android']>).physical;
}

function appPresence(env: EnvironmentState, platform: StatsPlatform, device: DeviceRecord): AppPresence {
  if (!isRunning(platform, device) || device.app?.state === 'running') return null;
  const everBuilt = env.builds?.[platform]?.some((entry) => entry.result === 'succeeded') ?? true;
  if (env.lastBuilds?.[platform]?.status === 'failed' && !everBuilt) return 'none';
  return device.app?.state === 'stopped' ? 'closed' : null;
}

function deviceSlots(env: EnvironmentState) {
  return [{ slot: 'default', ios: env.ios, android: env.android }, ...(env.slots ?? [])];
}

function latestBuild(env: EnvironmentState): LastBuildReport | null {
  let latest: LastBuildReport | null = null;
  for (const platform of PLATFORMS) {
    const build = env.lastBuilds?.[platform];
    if (build && (latest === null || Date.parse(build.startedAt) > Date.parse(latest.startedAt))) latest = build;
  }
  return latest;
}

function stage(
  kind: WorkspaceStage['kind'],
  since: string | null | undefined,
  platform: StatsPlatform | 'macos' | null = null,
): WorkspaceStage {
  return { kind, since: since ?? null, platform, closedApps: [] };
}

function workspaceStage(env: EnvironmentState): WorkspaceStage {
  if (env.macos?.build.state === 'running') return stage('building', env.macos.build.startedAt, 'macos');
  if (env.macos?.build.state === 'failed')
    return stage('build-failed', env.macos.build.finishedAt ?? env.macos.build.startedAt, 'macos');
  if (env.build?.state === 'running') return stage('building', env.build.startedAt, env.build.platform);
  if (!env.live && env.phase === 'warming') return stage('warming', env.phaseSince);
  if (!env.live && env.phase === 'ready') return stage('ready', env.phaseSince);
  const latest = latestBuild(env);
  if (latest?.status === 'failed') return stage('build-failed', latest.finishedAt ?? latest.startedAt, latest.platform);
  if (env.live || (env.remoteDevices?.length ?? 0) > 0) {
    const closedApps = deviceSlots(env).flatMap(({ slot, ...devices }) =>
      PLATFORMS.flatMap((platform) => {
        const device = devices[platform];
        return device && appPresence(env, platform, device) === 'closed' ? [{ platform, slot }] : [];
      }),
    );
    return { ...stage('running', env.supervisor?.startedAt), closedApps };
  }
  const lastStop = env.metro?.lastStop;
  return stage('stopped', lastStop && 'at' in lastStop ? lastStop.at : null);
}

function checksState(checks: NonNullable<WorktreeFacts['pullRequest']>['checks']): ChecksState {
  if (!checks) return null;
  if (checks.failing > 0) return 'failing';
  if (checks.pending > 0) return 'pending';
  return checks.passing > 0 ? 'passing' : null;
}

function gitChip(worktree: WorktreeFacts): GitChip | null {
  const git = worktree.git;
  if (!git) return null;
  const pull = worktree.pullRequest;
  const parts: GitChipPart[] = [];
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  if (ahead || behind) parts.push({ kind: 'arrows', ahead, behind });
  const uncommitted = git.changed + git.untracked;
  if (uncommitted) parts.push({ kind: 'changed', count: uncommitted });
  if (git.mergedInto !== null) {
    if (pull?.state !== 'merged') parts.push({ kind: 'merged', into: git.mergedInto });
  } else if (git.upstream === null) {
    parts.push({ kind: 'no-upstream' });
  }
  return { parts, ci: pull ? checksState(pull.checks) : null };
}

function buildCause(build: LastBuildReport | BuildHistoryEntry): BuildCause | null {
  if (('result' in build ? build.result : build.status) !== 'failed') return null;
  const at = build.diagnostics?.find((d) => d.file && d.line !== null && d.line !== undefined);
  if (at) return { key: `${at.file}:${at.line}`, file: at.file, line: at.line };
  return { key: build.errorCode ?? 'failed', file: null, line: null };
}

function withCauses<T extends LastBuildReport>(
  builds: Partial<Record<StatsPlatform, T[]>> | undefined,
): Partial<Record<StatsPlatform, T[]>> | undefined {
  if (!builds) return builds;
  return Object.fromEntries(
    Object.entries(builds).map(([platform, list]) => [platform, list?.map((build) => withCause(build))]),
  );
}

function withCause<T extends LastBuildReport>(build: T): T {
  const cause = buildCause(build);
  return cause ? { ...build, cause } : build;
}

export function withGitChip(worktree: WorktreeFacts): WorktreeFacts {
  const chip = gitChip(worktree);
  return chip ? { ...worktree, gitChip: chip } : worktree;
}

/** The environment with the conclusions clients draw from it: `stage`, `appPresence`, `gitChip` and `cause`. */
export function withDerivedFacts<T extends EnvironmentState>(env: T): T {
  const device = <D extends DeviceRecord | null | undefined>(platform: StatsPlatform, record: D): D =>
    record ? { ...record, appPresence: appPresence(env, platform, record) } : record;
  const derived: T = { ...env, stage: workspaceStage(env) };
  if (env.ios) derived.ios = device('ios', env.ios);
  if (env.android) derived.android = device('android', env.android);
  if (env.slots) {
    derived.slots = env.slots.map((slot) => ({
      ...slot,
      ios: device('ios', slot.ios),
      android: device('android', slot.android),
    }));
  }
  if (env.worktree) derived.worktree = withGitChip(env.worktree);
  if (env.lastBuilds) {
    derived.lastBuilds = Object.fromEntries(
      Object.entries(env.lastBuilds).map(([platform, build]) => [platform, withCause(build)]),
    );
  }
  if (env.builds) derived.builds = withCauses(env.builds);
  return derived;
}
