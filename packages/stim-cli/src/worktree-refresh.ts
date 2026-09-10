import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { formatDuration, phaseLine } from './command-output.ts';
import {
  dependencyState,
  hasInstalledDependencies,
  installedNpmTreeIsValid,
  locallyKnownUpstream,
  type UpstreamState,
} from './doctor.ts';
import { DEPS_ERROR, podsAreStale, readPodState, runCaptured, runPodInstall } from './engine/deps.ts';
import { HEARTBEAT_INTERVAL_MS } from './engine/xcode.ts';
import { getExecutor } from './exec.ts';
import type { SettingsObject } from './types.ts';
import { resolveFullRef } from './worktree.ts';

export interface RefreshFailure {
  code: string;
  message: string;
  lines: string[];
  remedy: string | null;
}

export interface MainCheckoutState {
  branch: string | null;
  operation: 'rebase' | 'merge' | 'am' | null;
  dirtyTracked: string[];
  dirtyKnown: boolean;
}

const DIRTY_PATHS_SHOWN = 5;

const FETCH_TIMEOUT_MS = 120_000;

export function mainCheckoutRefusal(root: string, state: MainCheckoutState): RefreshFailure | null {
  if (state.operation) {
    return {
      code: 'STIM_MAIN_DIRTY',
      message: `Refusing to refresh ${root}: a ${state.operation === 'am' ? 'git am' : state.operation} is in progress there.`,
      lines: [],
      remedy: `Finish it, or run \`git -C ${root} ${state.operation} --abort\`, then run warm again.`,
    };
  }
  if (!state.dirtyKnown) {
    return {
      code: 'STIM_MAIN_DIRTY',
      message: `Refusing to refresh ${root}: git could not report whether its tracked files are modified.`,
      lines: [],
      remedy: `Run \`git -C ${root} status\` to see what it reports, clear it, then run warm again.`,
    };
  }
  if (state.dirtyTracked.length) {
    return {
      code: 'STIM_MAIN_DIRTY',
      message: `Refusing to refresh ${root}: it has uncommitted changes to tracked files.`,
      lines: state.dirtyTracked.slice(0, DIRTY_PATHS_SHOWN),
      remedy: `Commit them, or run \`git -C ${root} stash push -u -m warm-refresh\`, then run warm again.`,
    };
  }
  if (state.branch === null) {
    return {
      code: 'STIM_MAIN_DETACHED',
      message: `Refusing to refresh ${root}: its HEAD is detached, so there is no branch to fast-forward.`,
      lines: [],
      remedy: `Run \`git -C ${root} checkout <branch>\`, then run warm again.`,
    };
  }
  return null;
}

export type CheckoutPlan =
  | { kind: 'no-upstream' }
  | { kind: 'current'; ahead: number; upstream: string }
  | { kind: 'fast-forward'; behind: number; upstream: string }
  | { kind: 'diverged'; ahead: number; behind: number; upstream: string };

export function checkoutPlan(upstream: UpstreamState | null): CheckoutPlan {
  if (!upstream) return { kind: 'no-upstream' };
  const { name, ahead, behind } = upstream;
  if (ahead > 0 && behind > 0) return { kind: 'diverged', ahead, behind, upstream: name };
  if (behind > 0) return { kind: 'fast-forward', behind, upstream: name };
  return { kind: 'current', ahead, upstream: name };
}

export function divergedRefusal(
  root: string,
  branch: string,
  plan: { ahead: number; behind: number; upstream: string },
): RefreshFailure {
  return {
    code: 'STIM_MAIN_DIVERGED',
    message: `Refusing to refresh ${root}: ${branch} is ${plan.ahead} ahead of and ${plan.behind} behind ${plan.upstream}, so it cannot fast-forward.`,
    lines: [],
    remedy: `Rebase or merge ${branch} yourself, then run warm again. Warm never merges, resets, or switches a branch.`,
  };
}

function checkoutFactLine(branch: string, plan: Exclude<CheckoutPlan, { kind: 'diverged' }>, head: string): string {
  const shortHead = head.slice(0, 7);
  if (plan.kind === 'no-upstream') {
    return phaseLine('checkout', `${branch} has no upstream -> left${shortHead ? ` at ${shortHead}` : ' alone'}`);
  }
  if (plan.kind === 'fast-forward') {
    return phaseLine(
      'checkout',
      `${branch} ${plan.behind} commit${plan.behind === 1 ? '' : 's'} behind ${plan.upstream} -> fast-forwarded to ${shortHead}`,
    );
  }
  const ahead = plan.ahead > 0 ? `, ${plan.ahead} ahead` : '';
  return phaseLine('checkout', `${branch} up to date with ${plan.upstream}${ahead}`);
}

export interface DepsInputs {
  lockfile: string | null;
  lockfileChanged: boolean;
  installed: boolean;
  treeValid: boolean | null;
}

export interface StepPlan {
  run: boolean;
  reason: string;
}

export function depsPlan({ lockfile, lockfileChanged, installed, treeValid }: DepsInputs): StepPlan {
  if (!lockfile) return { run: false, reason: 'no lockfile in this repository' };
  if (!installed) return { run: true, reason: 'no installed dependencies' };
  if (lockfileChanged) return { run: true, reason: `${lockfile} changed` };
  if (treeValid === false) return { run: true, reason: `the installed tree does not match ${lockfile}` };
  return { run: false, reason: `${lockfile} unchanged` };
}

export interface PodsInputs {
  hasIos: boolean;
  hasPodfile: boolean;
  podfileLockChanged: boolean;
  stale: { noPods?: boolean; stale: boolean; reason?: string };
}

export function podsPlan({ hasIos, hasPodfile, podfileLockChanged, stale }: PodsInputs): StepPlan {
  if (!hasIos) return { run: false, reason: 'no ios/ directory' };
  if (!hasPodfile) return { run: false, reason: 'no ios/Podfile' };
  if (stale.noPods) return { run: false, reason: 'no ios/Pods and no ios/Podfile.lock' };
  if (podfileLockChanged) return { run: true, reason: 'ios/Podfile.lock changed' };
  if (stale.stale) return { run: true, reason: stale.reason ?? 'ios/Pods does not match ios/Podfile.lock' };
  return { run: false, reason: 'ios/Podfile.lock unchanged' };
}

export type DefaultBranchNote = { kind: 'match' } | { kind: 'warn' | 'unknown'; lines: string[] };

export function defaultBranchNote(branch: string, defaultBranch: string | null): DefaultBranchNote {
  if (defaultBranch === null) {
    return {
      kind: 'unknown',
      lines: [
        'could not tell the default branch: no worktree.defaultBranch setting and no',
        'origin/HEAD. Run `git remote set-head origin -a` to record one.',
      ],
    };
  }
  if (defaultBranch === branch) return { kind: 'match' };
  return {
    kind: 'warn',
    lines: [
      `not the default branch (${defaultBranch}); worktrees seeded from this copy`,
      `carry ${branch}'s dependencies`,
    ],
  };
}

function stepLine(label: string, reason: string, action: string): string {
  return phaseLine(label, `${reason} -> ${action}`);
}

function inProgressOperation(gitDir: string): MainCheckoutState['operation'] {
  if (existsSync(join(gitDir, 'rebase-merge'))) return 'rebase';
  if (existsSync(join(gitDir, 'rebase-apply'))) {
    // git-rebase--am and git am share rebase-apply; only am writes `applying`.
    return existsSync(join(gitDir, 'rebase-apply', 'applying')) ? 'am' : 'rebase';
  }
  return existsSync(join(gitDir, 'MERGE_HEAD')) ? 'merge' : null;
}

function readMainCheckoutState(root: string): MainCheckoutState {
  const exec = getExecutor();
  const gitDir = exec.runFileQuiet('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir'])?.trim();
  const changed = exec.runFileQuiet('git', ['-C', root, 'diff', '--name-only', 'HEAD']);
  const branch = exec.runFileQuiet('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() || null;
  return {
    branch,
    operation: gitDir ? inProgressOperation(gitDir) : null,
    dirtyTracked: (changed ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    dirtyKnown: changed !== null,
  };
}

function resolveDefaultBranch(root: string, settings: SettingsObject): string | null {
  const worktree = settings.worktree;
  const configured =
    worktree && typeof worktree === 'object' && !Array.isArray(worktree)
      ? (worktree as { defaultBranch?: unknown }).defaultBranch
      : undefined;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const head = getExecutor()
    .runFileQuiet('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    ?.trim();
  if (!head) return null;
  const cut = head.indexOf('/');
  return cut > 0 ? head.slice(cut + 1) : head;
}

function branchRemote(root: string, branch: string): string {
  return (
    getExecutor()
      .runFileQuiet('git', ['-C', root, 'config', `branch.${branch}.remote`])
      ?.trim() || 'origin'
  );
}

function gitPath(...parts: string[]): string {
  return parts.filter((part) => part && part !== '.').join('/');
}

function pathChangedBetween(root: string, from: string, to: string, path: string): boolean {
  if (from === to || !from || !to) return false;
  const out = getExecutor().runFileQuiet('git', ['-C', root, 'diff', '--name-only', from, to, '--', path]);
  return Boolean(out && out.trim());
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

const LAST_LINES = 20;

interface InstallRun {
  ok: boolean;
  durationMs: number;
  reason: string | null;
  lastLines: string[];
}

async function runInstallCommand({
  command,
  cwd,
  spawnFn,
  now,
  heartbeatMs,
  onHeartbeat,
}: {
  command: string;
  cwd: string;
  spawnFn: SpawnFn;
  now: () => number;
  heartbeatMs: number;
  onHeartbeat: (line: string) => void;
}): Promise<InstallRun> {
  const [bin, ...args] = command.split(' ');
  const run = await runCaptured({
    logWriter: null,
    spawn: spawnFn,
    now,
    heartbeatMs,
    onHeartbeat,
    cmd: String(bin),
    args,
    cwd,
    env: { ...process.env, FORCE_COLOR: '0' },
    event: 'warm_deps_install',
    label: 'deps',
  });
  const lastLines = run.transcript.slice(-LAST_LINES);
  if (run.error) {
    const reason = `Could not run \`${command}\`: ${(run.error as Error)?.message || run.error}`;
    return { ok: false, durationMs: run.durationMs, reason, lastLines };
  }
  if (run.code !== 0) {
    const how = run.signal ? `signal ${run.signal}` : `exit code ${run.code}`;
    return { ok: false, durationMs: run.durationMs, reason: `\`${command}\` failed (${how}).`, lastLines };
  }
  return { ok: true, durationMs: run.durationMs, reason: null, lastLines };
}

function fastForward(root: string, upstream: string): { ok: boolean; lines: string[] } {
  try {
    getExecutor().runFile('git', ['-C', root, 'merge', '--ff-only', '--end-of-options', upstream]);
    return { ok: true, lines: [] };
  } catch (error) {
    const reported = String((error as { stderr?: unknown })?.stderr || (error as Error)?.message || error);
    return {
      ok: false,
      lines: reported
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5),
    };
  }
}

export interface RefreshOptions {
  root: string;
  appDir: string;
  settings: SettingsObject;
  emit: (line: string) => void;
  spawnFn?: SpawnFn | null;
  now?: () => number;
  heartbeatMs?: number;
}

export async function refreshMainCheckout({
  root,
  appDir,
  settings,
  emit,
  spawnFn = null,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
}: RefreshOptions): Promise<RefreshFailure | null> {
  const state = readMainCheckoutState(root);
  const refusal = mainCheckoutRefusal(root, state);
  if (refusal) return refusal;
  const branch = String(state.branch);
  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));

  const before = resolveFullRef(root, 'HEAD') ?? '';
  // A fetch that prompts for credentials would hold the exclusive lock forever.
  const fetched = getExecutor().runFileQuiet('git', ['-C', root, 'fetch', '--prune', branchRemote(root, branch)], {
    timeoutMs: FETCH_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetched === null) emit(phaseLine('checkout', 'could not fetch; continuing with the local state'));

  const plan = checkoutPlan(locallyKnownUpstream(root));
  if (plan.kind === 'diverged') return divergedRefusal(root, branch, plan);

  let head = before;
  if (plan.kind === 'fast-forward') {
    const merged = fastForward(root, plan.upstream);
    if (!merged.ok) {
      return {
        code: 'STIM_MAIN_DIRTY',
        message: `Refusing to refresh ${root}: git could not fast-forward ${branch} to ${plan.upstream}.`,
        lines: merged.lines,
        remedy: 'Clear what git reports in the main checkout, then run warm again.',
      };
    }
    head = resolveFullRef(root, 'HEAD') ?? before;
  }
  emit(checkoutFactLine(branch, plan, head));

  const note = defaultBranchNote(branch, resolveDefaultBranch(root, settings));
  if (note.kind !== 'match') for (const line of note.lines) emit(phaseLine('', line));

  const dependencies = dependencyState(appDir);
  const installed = dependencies ? hasInstalledDependencies(dependencies.root, dependencies.installed) : false;
  const deps = depsPlan({
    lockfile: dependencies?.lock ?? null,
    lockfileChanged: dependencies
      ? pathChangedBetween(root, before, head, gitPath(relative(root, dependencies.root), dependencies.lock))
      : false,
    installed,
    treeValid:
      dependencies?.lock === 'package-lock.json' && installed ? installedNpmTreeIsValid(dependencies.root) : null,
  });
  if (deps.run && dependencies) {
    const install = await runInstallCommand({
      command: dependencies.command,
      cwd: dependencies.root,
      spawnFn: spawn,
      now,
      heartbeatMs,
      onHeartbeat: emit,
    });
    emit(stepLine('deps', deps.reason, `${dependencies.command} (${formatDuration(install.durationMs)})`));
    if (!install.ok) {
      return {
        code: DEPS_ERROR,
        message: String(install.reason),
        lines: install.lastLines,
        remedy: `Run \`cd ${dependencies.root} && ${dependencies.command}\` and fix what it reports, then run warm again.`,
      };
    }
  } else {
    emit(stepLine('deps', deps.reason, 'skipped'));
  }

  const app = relative(root, appDir) || '.';
  const where = app === '.' ? '' : `${app}: `;
  const podState = readPodState(appDir);
  const pods = podsPlan({
    hasIos: existsSync(join(appDir, 'ios')),
    hasPodfile: podState.hasPodfile,
    podfileLockChanged: pathChangedBetween(root, before, head, gitPath(app, 'ios', 'Podfile.lock')),
    stale: podsAreStale(podState.lockText, podState.manifestText),
  });
  if (!pods.run) {
    emit(stepLine('pods', `${where}${pods.reason}`, 'skipped'));
    return null;
  }
  const result = await runPodInstall(appDir, null, { spawnFn: spawn, now, heartbeatMs, onHeartbeat: emit });
  const podCommand = result.command ?? 'pod install';
  emit(
    stepLine(
      'pods',
      `${where}${pods.reason}`,
      result.durationMs === undefined ? podCommand : `${podCommand} (${formatDuration(result.durationMs)})`,
    ),
  );
  for (const podNote of result.notes ?? []) emit(phaseLine('pods', podNote));
  if (!result.ok) {
    return {
      code: result.code ?? DEPS_ERROR,
      message: result.reason ?? '`pod install` failed.',
      lines: result.lastLines ?? [],
      remedy: result.remedy ?? null,
    };
  }
  return null;
}
