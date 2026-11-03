import type { StimContext } from '@stim-cli/core';
import { join } from 'node:path';
import {
  changedDuringBuildLine,
  configInputsChanged,
  fingerprintProject,
  refingerprintAfterMutation,
} from '../cache/build-cache.ts';
import { podAction } from '../commands/ios/support.ts';
import { formatDuration, phaseLine, quotedPath } from '../command-output.ts';
import { dependencyState } from '../dependency-state.ts';
import { podsAreStale, readPodState, runPodInstall, type PodInstallResult } from '../engine/deps.ts';
import { planPrebuildAsync, recordPrebuildAsync, runPrebuild, staleNativeDirRefusal } from '../engine/prebuild.ts';
import { withWarmClaim, type WarmClaimHold } from '../engine/warm-claim.ts';
import { withIdleWorkspace, workspaceInUse } from '../workspace/in-use.ts';
import { resolveAndroidLayout, resolveIosProjectDir, type SettingsObject } from '../workspace/settings.ts';
import {
  awaitInstallerSettled,
  installerSpawn,
  runDependencyInstall,
  type RefreshFailure,
} from '../workspace/worktree-refresh.ts';
import { brokenPodLinks } from './doctor.ts';
import {
  planSourceRepairs,
  type NativePlatform,
  type SourceCheckoutFacts,
  type SourceRepairStep,
} from './doctor-source.ts';

export interface SourceRepairOptions {
  facts: SourceCheckoutFacts;
  repoRoot: string;
  settings: SettingsObject | null;
  operation: StimContext;
  confirm: ((question: string) => Promise<boolean>) | null;
  note: (line: string) => void;
}

function describeFailure(label: string, failure: RefreshFailure, note: (line: string) => void): void {
  note(phaseLine(label, `FAILED: ${failure.message}`));
  for (const line of failure.lines) note(phaseLine('', line));
  if (failure.remedy) note(phaseLine('', failure.remedy));
}

function podFailure(result: PodInstallResult): RefreshFailure {
  return {
    code: result.code ?? 'STIM_DEPS_FAILED',
    message: result.reason ?? '`pod install` failed.',
    lines: result.diagnosticLines?.length ? result.diagnosticLines : (result.lastLines ?? []).slice(-5),
    remedy: result.remedy ?? null,
  };
}

/** CocoaPods names one conflicting pod per run, and a pod that depends on another can name it next. */
const MAX_CONFLICT_UPDATES = 5;

interface RunContext extends SourceRepairOptions {
  hold: WarmClaimHold;
}

async function installPods(
  context: RunContext,
  { cleanPods = false, mayUpdatePods = false }: Pick<SourceRepairStep, 'cleanPods' | 'mayUpdatePods'>,
): Promise<RefreshFailure | null> {
  const { facts, hold, note, settings } = context;
  const iosDir = resolveIosProjectDir(settings, facts.root).dir;
  const spawnFn = installerSpawn(hold.installer, null);
  const run = async (podArgs: string[]): Promise<PodInstallResult> => {
    const result = await runPodInstall(facts.root, null, {
      spawnFn,
      directory: iosDir,
      podArgs,
      onHeartbeat: note,
    });
    for (const podNote of result.notes ?? []) note(phaseLine('pods', podNote));
    note(
      phaseLine(
        'pods',
        `${result.command ?? 'pod'} ${result.ok ? 'finished' : 'failed'}${result.durationMs === undefined ? '' : ` (${formatDuration(result.durationMs)})`}`,
      ),
    );
    const running = await awaitInstallerSettled(hold.installer, facts.root, 'the pod command', 'stim doctor --fix');
    return running
      ? { failed: true, code: running.code, reason: running.message, remedy: running.remedy ?? '' }
      : result;
  };

  let result = await run(cleanPods ? ['install', '--clean-install'] : ['install']);
  const updated: string[] = [];
  for (let round = 0; round < MAX_CONFLICT_UPDATES && result.failed; round += 1) {
    const named = (result.conflictPods ?? []).filter((pod) => !updated.includes(pod));
    if (!named.length) break;
    updated.push(...named);
    if (!mayUpdatePods)
      return {
        ...podFailure(result),
        remedy: `ios/ is tracked by git, so Stim does not edit its Podfile.lock. Run \`cd ${quotedPath(iosDir)} && pod update ${updated.join(' ')}\` yourself.`,
      };
    note(
      phaseLine(
        'pods',
        `Podfile.lock pins a version of ${named.join(', ')} that the Podfile no longer allows; updating only ${updated.length === 1 ? 'that pod' : 'the pods named so far'}`,
      ),
    );
    result = await run(['update', ...updated]);
  }
  if (updated.length && result.ok && cleanPods && (await brokenPodLinks(join(iosDir, 'Pods'))).length > 0)
    result = await run(['install', '--clean-install']);
  return result.ok ? null : podFailure(result);
}

async function repairPrebuild(context: RunContext, platform: NativePlatform, step: SourceRepairStep): Promise<boolean> {
  const { facts, repoRoot, settings, note } = context;
  const { root } = facts;
  const options =
    platform === 'ios'
      ? { platform, iosProjectPath: resolveIosProjectDir(settings, root).relative }
      : { platform, androidLayout: resolveAndroidLayout(settings, root, repoRoot) };
  const fail = (message: string, lines: string[] = [], remedy: string | null = null): false => {
    describeFailure('prebuild', { code: 'STIM_PREBUILD_FAILED', message, lines, remedy }, note);
    return false;
  };
  let before: Awaited<ReturnType<typeof fingerprintProject>>;
  try {
    before = await fingerprintProject(root, options);
  } catch (error) {
    return fail(`could not fingerprint ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before?.hash) return fail(`could not fingerprint ${root}: @expo/fingerprint produced no hash for it`);

  const plan = await planPrebuildAsync(
    root,
    platform,
    { isExpo: true, fingerprint: before.hash, sources: before.sources },
    context.operation.signal,
  );
  if (plan === 'refuse')
    return fail(staleNativeDirRefusal(platform).message, [], staleNativeDirRefusal(platform).remedy);
  if (plan === 'none') {
    note(phaseLine('prebuild', `${platform}/ is already current for this fingerprint`));
    return true;
  }

  await recordPrebuildAsync(root, platform, null);
  const prebuilt = await runPrebuild(root, platform, null);
  if (prebuilt.failed)
    return fail(
      prebuilt.reason ?? 'expo prebuild failed.',
      (prebuilt.lastLines ?? []).slice(-5),
      prebuilt.remedy ?? null,
    );
  note(
    phaseLine(
      'prebuild',
      `${platform}/ ${plan === 'generate' ? 'generated' : 'updated in place'} (${formatDuration(prebuilt.durationMs ?? 0)})`,
    ),
  );

  if (platform === 'ios') {
    const iosDir = resolveIosProjectDir(settings, root).dir;
    const podState = readPodState(root, iosDir);
    const verdict = podsAreStale(podState.lockText, podState.manifestText, podState.dir);
    if (podAction(podState, verdict, { prebuildRan: true }).install) {
      const failure = await installPods(context, step);
      if (failure) {
        describeFailure('pods', failure, note);
        return false;
      }
    }
  }

  const after = await refingerprintAfterMutation({
    projectRoot: root,
    platform,
    previousHash: before.hash,
    ...(platform === 'ios'
      ? { iosProjectPath: resolveIosProjectDir(settings, root).relative }
      : { androidLayout: resolveAndroidLayout(settings, root, repoRoot) }),
  });
  if (!after) return fail(`could not fingerprint ${root} after the prebuild, so its record was not written`);
  const edited = configInputsChanged(before.sources, after.sources, { prebuildRan: true });
  if (edited.length)
    return fail(
      `${changedDuringBuildLine(edited).replace(/; the build will be installed but not cached$/, '')}, so the prebuild record was not written`,
    );
  await recordPrebuildAsync(root, platform, after.hash);
  note(phaseLine('prebuild', `recorded ${platform}/ at fingerprint ${after.hash.slice(0, 8)}; worktrees can carry it`));
  return true;
}

async function runStep(context: RunContext, step: SourceRepairStep): Promise<boolean> {
  const { facts, repoRoot, hold, note } = context;
  if (step.id === 'deps') {
    const dependencies = dependencyState(facts.root, repoRoot);
    if (!dependencies) return true;
    const failure = await runDependencyInstall({
      dependencies,
      subject: `source ${dependencies.root}: ${facts.deps?.reason === 'missing' ? 'no installed dependencies' : `the installed tree does not match ${dependencies.lock}`}`,
      installer: hold.installer,
      spawn: installerSpawn(hold.installer, null),
      emit: note,
      again: 'stim doctor --fix',
    });
    if (failure) describeFailure('deps', failure, note);
    return !failure;
  }
  if (step.id === 'pods') {
    const failure = await installPods(context, step);
    if (failure) describeFailure('pods', failure, note);
    return !failure;
  }
  return repairPrebuild(context, step.id === 'prebuild:ios' ? 'ios' : 'android', step);
}

const LABELS: Record<SourceRepairStep['id'], string> = {
  deps: 'deps',
  pods: 'pods',
  'prebuild:ios': 'prebuild',
  'prebuild:android': 'prebuild',
};

export async function repairSourceCheckout(options: SourceRepairOptions): Promise<0 | 1> {
  const { facts, confirm, note, operation } = options;
  const steps = planSourceRepairs(facts);
  if (!steps.length) return 0;
  let exitCode: 0 | 1 = 0;

  const busy = workspaceInUse(facts.root);
  if (busy.length) {
    note(
      phaseLine(
        'source',
        `kept ${facts.root}: ${busy.join('; ')}. Stop it (\`stim stop\` there) and run \`stim doctor --fix\` again, or run the steps by hand:`,
      ),
    );
    for (const step of steps) note(phaseLine('', step.manual));
    return 1;
  }

  const approved: SourceRepairStep[] = [];
  for (const step of steps) {
    const label = LABELS[step.id];
    note(phaseLine(label, step.announce));
    if (!confirm) {
      note(phaseLine(label, `not run without a terminal to confirm it; run \`${step.manual}\` yourself`));
    } else if (await confirm('Run this step? [y/N] ')) approved.push(step);
    else note(phaseLine(label, 'skipped'));
  }
  if (!approved.length) return exitCode;

  try {
    const run = await withIdleWorkspace(
      facts.root,
      () =>
        withWarmClaim(
          { repositoryRoot: options.repoRoot, phase: 'refresh', ceilingMs: 0, signal: operation.signal },
          (hold) =>
            runApproved(
              { ...options, hold },
              approved,
              steps.some((step) => step.id === 'deps') && !approved.some((step) => step.id === 'deps'),
            ),
        ),
      { purpose: 'doctor --fix', operation },
    );
    if (run.ran) return run.value === 1 ? 1 : exitCode;
    note(
      phaseLine(
        'source',
        `kept ${facts.root}: ${run.reasons.join('; ')}. Run \`stim doctor --fix\` again when it is free.`,
      ),
    );
    return 1;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'STIM_LOCK_TIMEOUT')) throw error;
    note(
      phaseLine(
        'source',
        `kept ${options.repoRoot}: a \`stim worktree warm\` holds its warm claim. Run \`stim doctor --fix\` again when it finishes.`,
      ),
    );
    return 1;
  }
}

async function runApproved(context: RunContext, approved: SourceRepairStep[], depsDeclined: boolean): Promise<0 | 1> {
  const failed = new Set<string>(depsDeclined ? ['deps'] : []);
  let exitCode: 0 | 1 = 0;
  for (const step of approved) {
    const label = LABELS[step.id];
    if (step.id !== 'deps' && failed.has('deps')) {
      context.note(phaseLine(label, 'skipped: the dependencies are not repaired, and this step reads them'));
      exitCode = 1;
      continue;
    }
    if (!(await runStep(context, step))) {
      failed.add(step.id);
      exitCode = 1;
    }
  }
  return exitCode;
}
