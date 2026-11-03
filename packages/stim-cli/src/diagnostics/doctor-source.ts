import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { quotedPath } from '../command-output.ts';
import { dependencyState, hasInstalledDependencies } from '../dependency-state.ts';
import { podInstallCommand } from '../engine/bundler.ts';
import { prebuildRecordStatus, readPrebuildRecord, type PrebuildRecordStatus } from '../engine/prebuild.ts';
import { gitQuietAsync } from '../workspace/git.ts';
import { detectIsExpo } from '../workspace/project.ts';
import { installedTreeIsStaleAsync } from '../workspace/worktree-refresh.ts';
import { brokenPodLinks, podsManifestState, type DoctorPlatform, type Finding } from './doctor.ts';

export type NativePlatform = 'ios' | 'android';

export interface PrebuildRecordProblem {
  platform: NativePlatform;
  status: Exclude<PrebuildRecordStatus, { kind: 'current' }>;
}

export interface SourceCheckoutFacts {
  root: string;
  deps: { root: string; command: string; reason: 'missing' | 'stale' } | null;
  pods: { iosDir: string; broken: boolean; state: 'missing' | 'stale' | null; iosTracked: boolean } | null;
  prebuild: PrebuildRecordProblem[];
}

type SourceRepairId = 'deps' | 'pods' | 'prebuild:ios' | 'prebuild:android';

export interface SourceRepairStep {
  id: SourceRepairId;
  announce: string;
  manual: string;
  cleanPods?: boolean;
  mayUpdatePods?: boolean;
}

function nativeDir(platform: NativePlatform): string {
  return `${platform}/`;
}

export function prebuildRecordFinding({ platform, status }: PrebuildRecordProblem): Finding {
  const dir = nativeDir(platform);
  const why =
    status.kind === 'unfinished'
      ? `Stim's last prebuild of the source checkout's ${dir} did not finish`
      : status.kind === 'unrecorded'
        ? `Stim has no record of generating the source checkout's ${dir}`
        : status.kind === 'moved'
          ? `The source checkout's ${dir} was generated from an older fingerprint than the checkout has now`
          : `Stim could not fingerprint the source checkout to compare its ${dir} with the record`;
  const cost =
    platform === 'ios'
      ? `so every worktree generates ios/ again and installs its own Pods, about 1.5 to 2 GB of private disk each, instead of cloning them`
      : `so every worktree generates android/ again instead of cloning it`;
  return {
    code: `source-prebuild-record-${platform}`,
    level: 'cost',
    title: `Stim has no current prebuild record for the source checkout's ${dir}`,
    detail: `${why}, and \`stim worktree warm\` carries a native directory only when that record matches, ${cost}.`,
    fix: `Run stim doctor --fix in a terminal to run the prebuild${platform === 'ios' ? ' and pod install' : ''} without compiling, or run stim ${platform} once in the source checkout.`,
  };
}

export async function inspectPrebuildRecords({
  root,
  platform,
  host,
}: {
  root: string;
  platform?: DoctorPlatform;
  host: NodeJS.Platform;
}): Promise<PrebuildRecordProblem[]> {
  if (!detectIsExpo(root)) return [];
  const platforms: NativePlatform[] = [
    ...(platform !== 'android' && host === 'darwin' ? (['ios'] as const) : []),
    ...(platform !== 'ios' ? (['android'] as const) : []),
  ];
  const problems: PrebuildRecordProblem[] = [];
  for (const each of platforms) {
    if (!existsSync(join(root, each))) continue;
    if ((await gitQuietAsync(root, ['check-ignore', '-q', '--', each])) === null) continue;
    if ((await gitQuietAsync(root, ['ls-files', '--', each]))?.trim() !== '') continue;
    const { recorded, current } = await readPrebuildRecord(root, each);
    const status = prebuildRecordStatus(recorded, current);
    if (status.kind !== 'current') problems.push({ platform: each, status });
  }
  return problems;
}

export async function inspectSourceFacts({
  root,
  repoRoot,
  platform,
  host,
  iosProjectPath,
}: {
  root: string;
  repoRoot: string;
  platform?: DoctorPlatform;
  host: NodeJS.Platform;
  iosProjectPath: string;
}): Promise<SourceCheckoutFacts> {
  const dependencies = dependencyState(root, repoRoot);
  let deps: SourceCheckoutFacts['deps'] = null;
  if (dependencies) {
    const installed = hasInstalledDependencies(dependencies.root, dependencies.installed);
    if (!installed) deps = { root: dependencies.root, command: dependencies.command, reason: 'missing' };
    else if (await installedTreeIsStaleAsync(dependencies))
      deps = { root: dependencies.root, command: dependencies.command, reason: 'stale' };
  }

  let pods: SourceCheckoutFacts['pods'] = null;
  const iosDir = join(root, iosProjectPath);
  if (platform !== 'android' && host === 'darwin' && existsSync(join(iosDir, 'Podfile.lock'))) {
    const state = podsManifestState(join(iosDir, 'Podfile.lock'), join(iosDir, 'Pods', 'Manifest.lock'));
    const podsDir = join(iosDir, 'Pods');
    const broken = existsSync(podsDir) && (await brokenPodLinks(podsDir)).length > 0;
    if (state || broken) {
      const tracked = await gitQuietAsync(root, ['ls-files', '--', iosProjectPath]);
      pods = { iosDir, broken, state, iosTracked: tracked === null || tracked.trim() !== '' };
    }
  }

  return { root, deps, pods, prebuild: await inspectPrebuildRecords({ root, platform, host }) };
}

function podsAnnouncement(clean: boolean, updates: boolean): string {
  const install = clean ? '`pod install --clean-install`' : '`pod install`';
  const update = updates
    ? ', and when CocoaPods reports that Podfile.lock pins a version a pod no longer allows, `pod update` of only the pods it names'
    : '';
  return `Runs ${install} in ios/${update}. This rebuilds ios/Pods from Podfile.lock and takes a few minutes.`;
}

export function planSourceRepairs(facts: SourceCheckoutFacts): SourceRepairStep[] {
  const steps: SourceRepairStep[] = [];
  const { deps, pods, prebuild } = facts;
  if (deps) {
    const replaces =
      deps.command === 'npm ci' ? ' `npm ci` deletes node_modules first, so it replaces the whole tree.' : '';
    steps.push({
      id: 'deps',
      announce: `Runs \`${deps.command}\` in ${deps.root} to ${deps.reason === 'missing' ? 'install' : 'reinstall'} the packages its lockfile names. This takes minutes and needs the network.${replaces}`,
      manual: `cd ${quotedPath(deps.root)} && ${deps.command}`,
    });
  }
  const mayUpdatePods = pods ? !pods.iosTracked : true;
  const podsInstall = pods
    ? podInstallCommand(facts.root, pods.iosDir, ...(pods.broken ? ['--clean-install'] : []))
    : '';
  const ios = prebuild.find((problem) => problem.platform === 'ios');
  if (ios) {
    steps.push({
      id: 'prebuild:ios',
      announce: `Runs \`expo prebuild\` for ios/, then \`pod install\`, and records the fingerprint. This does not compile, and takes a few minutes. It runs on the source checkout's own ios/, which git ignores.`,
      manual: `cd ${quotedPath(facts.root)} && stim ios`,
      cleanPods: pods?.broken ?? false,
      mayUpdatePods,
    });
  } else if (pods) {
    steps.push({
      id: 'pods',
      announce: podsAnnouncement(pods.broken, mayUpdatePods),
      manual: `cd ${quotedPath(pods.iosDir)} && ${podsInstall}`,
      cleanPods: pods.broken,
      mayUpdatePods,
    });
  }
  if (prebuild.some((problem) => problem.platform === 'android')) {
    steps.push({
      id: 'prebuild:android',
      announce:
        "Runs `expo prebuild` for android/ and records the fingerprint. This does not compile, and takes under a minute. It runs on the source checkout's own android/, which git ignores.",
      manual: `cd ${quotedPath(facts.root)} && stim android`,
    });
  }
  return steps;
}
