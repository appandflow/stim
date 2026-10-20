import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { formatDuration, formatElapsed, phaseLine } from '../command-output.ts';
import { getConfigDir } from './config.ts';
import {
  type DependencyState,
  dependencyState,
  hasInstalledDependencies,
  installedNpmTreeProblems,
} from '../dependency-state.ts';
import { DEPS_ERROR, podsAreStale, readPodState, runCaptured, runPodInstall } from '../engine/deps.ts';
import { NO_INSTALLER_CLAIM, type InstallerClaim } from '../engine/warm-claim.ts';
import { HEARTBEAT_INTERVAL_MS } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import { git, gitQuiet } from './git.ts';
import type { SettingsObject } from '@stim-cli/core/state';
import { locallyKnownUpstream, resolveFullRef, type UpstreamState } from './worktree.ts';
import type { IosProjectDir } from './settings.ts';

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

interface InstallEvidence {
  lock: string;
  hash: string;
  patches: string;
  completed: boolean;
  treeProblems: string | null;
}

export interface DepsInputs {
  lockfile: string | null;
  lockfileChanged: boolean;
  patchesChanged: boolean;
  installed: boolean;
  treeProblems: string | null;
  lastInstall: InstallEvidence | null;
  lockHash: string | null;
  patchesHash: string;
}

export interface StepPlan {
  run: boolean;
  reason: string;
}

/**
 * Whether to install, decided against the lockfile as it stands now rather than against what HEAD did.
 * A lockfile that did not move is not evidence that its dependencies are installed: an install that was
 * interrupted leaves a present node_modules behind and moves HEAD no further. A `patches/` change counts
 * as a dependency change because patch-package applies it only on a fresh install. A tree `npm ls` already
 * rejected right after the last completed install, with the same problems, is not one another install would fix.
 */
export function depsPlan({
  lockfile,
  lockfileChanged,
  patchesChanged,
  installed,
  treeProblems,
  lastInstall,
  lockHash,
  patchesHash,
}: DepsInputs): StepPlan {
  if (!lockfile) return { run: false, reason: 'no lockfile in this repository' };
  if (!installed) return { run: true, reason: 'no installed dependencies' };
  if (treeProblems && lastInstall?.treeProblems !== treeProblems) {
    return { run: true, reason: `the installed tree does not match ${lockfile}` };
  }
  if (lastInstall) {
    if (!lastInstall.completed) return { run: true, reason: `the last install of ${lastInstall.lock} did not finish` };
    if (lastInstall.lock !== lockfile)
      return { run: true, reason: `the last completed install was of ${lastInstall.lock}` };
    if (lockHash === null || lastInstall.hash !== lockHash) {
      return { run: true, reason: `${lockfile} does not match the last completed install` };
    }
    if (lastInstall.patches !== patchesHash) {
      return { run: true, reason: 'patches/ does not match the last completed install' };
    }
    return { run: false, reason: `${lockfile} matches the last completed install` };
  }
  if (lockfileChanged) return { run: true, reason: `${lockfile} changed` };
  if (patchesChanged) return { run: true, reason: 'patches/ changed' };
  return { run: false, reason: `${lockfile} unchanged` };
}

/**
 * Why a copy must not read the source checkout's dependencies: the install recorded for the lockfile as it
 * stands now did not finish, so what is installed there is partial. A record of any other lockfile says
 * nothing about this one, and no record at all is the state of every repository before its first refresh.
 */
export function incompleteInstallRefusal(root: string, appDir: string): RefreshFailure | null {
  for (const dependencies of dependencyStates(root, appDir)) {
    const last = readInstallEvidence(dependencies.root);
    if (!last || last.completed || last.lock !== dependencies.lock) continue;
    const hash = lockfileHash(dependencies.root, dependencies.lock);
    if (hash === null || last.hash !== hash) continue;
    return {
      code: 'STIM_DEPS_INCOMPLETE',
      message: `Refusing to copy from ${dependencies.root}: the last install of ${dependencies.lock} there did not finish, so its dependencies are partial.`,
      lines: [],
      remedy: `Run \`stim worktree warm --refresh\` to install them in the source checkout -- it reinstalls rather than skipping, because no completed install of this ${dependencies.lock} is recorded -- then warm again.`,
    };
  }
  return null;
}

function dependencyStates(root: string, appDir: string): DependencyState[] {
  const states = [dependencyState(root, root), dependencyState(existsSync(appDir) ? appDir : root)];
  return states.filter(
    (state, index): state is DependencyState =>
      state !== null && states.findIndex((other) => other?.root === state.root) === index,
  );
}

/**
 * An npm project whose own `.npmrc` sets `ignore-scripts` gets no lifecycle scripts from `npm ci`, its own
 * postinstall included. `npm run` still runs a named script under that setting, so the project's postinstall
 * (usually patch-package) runs explicitly; dependencies' install scripts stay blocked.
 */
function skippedPostinstall(dependencies: DependencyState): boolean {
  if (dependencies.lock !== 'package-lock.json') return false;
  let postinstall: unknown;
  try {
    postinstall = JSON.parse(readFileSync(join(dependencies.root, 'package.json'), 'utf-8'))?.scripts?.postinstall;
  } catch {
    return false;
  }
  if (typeof postinstall !== 'string' || !postinstall.trim()) return false;
  try {
    const value = getExecutor().runFile('npm', ['config', 'get', 'ignore-scripts'], {
      cwd: dependencies.root,
      timeoutMs: 30_000,
    });
    return value === 'true';
  } catch {
    return false;
  }
}

export interface PodsInputs {
  hasIos: boolean;
  hasPodfile: boolean;
  podfileLockChanged: boolean;
  stale: { noPods?: boolean; stale: boolean; reason?: string };
  dir?: string;
}

export function podsPlan({ hasIos, hasPodfile, podfileLockChanged, stale, dir = 'ios/' }: PodsInputs): StepPlan {
  if (!hasIos) return { run: false, reason: `no ${dir || './'} directory` };
  if (!hasPodfile) return { run: false, reason: `no ${dir}Podfile` };
  if (stale.noPods) return { run: false, reason: `no ${dir}Pods and no ${dir}Podfile.lock` };
  if (podfileLockChanged) return { run: true, reason: `${dir}Podfile.lock changed` };
  if (stale.stale) return { run: true, reason: stale.reason ?? `${dir}Pods does not match ${dir}Podfile.lock` };
  return { run: false, reason: `${dir}Podfile.lock unchanged` };
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

function installRecordFile(depsRoot: string): string {
  return join(getConfigDir(), 'warm-installs', `${workspaceName(depsRoot)}.json`);
}

function lockfileHash(depsRoot: string, lockfile: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(join(depsRoot, lockfile)))
      .digest('hex');
  } catch {
    return null;
  }
}

function hashPatches(depsRoot: string): string {
  const dir = join(depsRoot, 'patches');
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((name) => name.endsWith('.patch'))
      .toSorted();
  } catch {
    return '';
  }
  if (!names.length) return '';
  const hash = createHash('sha256');
  for (const name of names)
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0');
  return hash.digest('hex');
}

function readInstallEvidence(depsRoot: string): InstallEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(installRecordFile(depsRoot), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.lock !== 'string' || typeof parsed.hash !== 'string') return null;
    return {
      lock: parsed.lock,
      hash: parsed.hash,
      patches: typeof parsed.patches === 'string' ? parsed.patches : '',
      completed: parsed.completed === true,
      treeProblems: typeof parsed.treeProblems === 'string' ? parsed.treeProblems : null,
    };
  } catch {
    return null;
  }
}

function writeInstallEvidence(depsRoot: string, evidence: InstallEvidence): void {
  const file = installRecordFile(depsRoot);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(join(getConfigDir(), 'warm-installs'), { recursive: true });
  writeFileSync(tmp, JSON.stringify(evidence));
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function pendingInstallEvidence(dependencies: DependencyState): InstallEvidence {
  return {
    lock: dependencies.lock,
    hash: lockfileHash(dependencies.root, dependencies.lock) ?? '',
    patches: hashPatches(dependencies.root),
    completed: false,
    treeProblems: null,
  };
}

function restoreInstallEvidence(depsRoot: string, prior: InstallEvidence | null): void {
  if (prior) writeInstallEvidence(depsRoot, prior);
  else rmSync(installRecordFile(depsRoot), { force: true });
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
  const gitDir = gitQuiet(root, ['rev-parse', '--path-format=absolute', '--git-dir'])?.trim();
  // `git diff HEAD` compares the working tree to HEAD, so it misses a staged edit
  // whose working file was restored to the HEAD contents without resetting the index.
  const worktreeChanged = gitQuiet(root, ['diff', '--name-only', 'HEAD']);
  const indexChanged = gitQuiet(root, ['diff', '--name-only', '--cached', 'HEAD']);
  const branch = gitQuiet(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() || null;
  const paths = [worktreeChanged, indexChanged].flatMap((out) =>
    (out ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return {
    branch,
    operation: gitDir ? inProgressOperation(gitDir) : null,
    dirtyTracked: [...new Set(paths)],
    dirtyKnown: worktreeChanged !== null && indexChanged !== null,
  };
}

function resolveDefaultBranch(root: string, settings: SettingsObject): string | null {
  const worktree = settings.worktree;
  const configured =
    worktree && typeof worktree === 'object' && !Array.isArray(worktree)
      ? (worktree as { defaultBranch?: unknown }).defaultBranch
      : undefined;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const head = gitQuiet(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (!head) return null;
  const cut = head.indexOf('/');
  return cut > 0 ? head.slice(cut + 1) : head;
}

function branchRemote(root: string, branch: string): string {
  return gitQuiet(root, ['config', `branch.${branch}.remote`])?.trim() || 'origin';
}

function remoteUpstreamIsCurrent(root: string, branch: string): boolean {
  const merge = gitQuiet(root, ['config', '--get-all', `branch.${branch}.merge`])?.trim();
  if (!merge) return true;
  if (!merge.startsWith('refs/') || merge.includes('\n')) return false;
  const remote = branchRemote(root, branch);
  if (remote === '.') return true;
  const local = resolveFullRef(root, '@{upstream}');
  if (!local) return false;
  const advertised = gitQuiet(root, ['ls-remote', '--exit-code', '--refs', '--', remote, merge], {
    timeoutMs: FETCH_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (advertised === null) return false;
  const refs = advertised
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/));
  return refs.length === 1 && refs[0]?.[0] === local && refs[0]?.[1] === merge;
}

function gitPath(...parts: string[]): string {
  return parts.filter((part) => part && part !== '.').join('/');
}

function pathChangedBetween(root: string, from: string, to: string, path: string): boolean {
  if (from === to || !from || !to) return false;
  const out = gitQuiet(root, ['diff', '--name-only', from, to, '--', path]);
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
    git(root, ['merge', '--ff-only', '--end-of-options', upstream], { write: true, timeoutMs: 'unbounded' });
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
  iosProject: IosProjectDir;
  emit: (line: string) => void;
  spawnFn?: SpawnFn | null;
  now?: () => number;
  heartbeatMs?: number;
  installer?: InstallerClaim;
  inspectOnly?: boolean;
}

export interface RefreshMutation {
  mutation: string;
}

export function refreshMainCheckout(
  options: RefreshOptions & { inspectOnly: true },
): Promise<RefreshFailure | RefreshMutation | null>;
export function refreshMainCheckout(options: RefreshOptions & { inspectOnly?: false }): Promise<RefreshFailure | null>;
export async function refreshMainCheckout({
  root,
  appDir,
  settings,
  iosProject,
  emit,
  spawnFn = null,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  installer = NO_INSTALLER_CLAIM,
  inspectOnly = false,
}: RefreshOptions): Promise<RefreshFailure | RefreshMutation | null> {
  const state = readMainCheckoutState(root);
  const refusal = mainCheckoutRefusal(root, state);
  if (refusal) return refusal;
  const branch = String(state.branch);
  const spawnChild: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const spawn: SpawnFn = (cmd, args, opts) => {
    installer.declare();
    let child;
    try {
      // The claim resolves the install through its process group, so it has to lead one.
      child = spawnChild(cmd, args, { ...opts, detached: true });
    } catch (error) {
      installer.record(null);
      throw error;
    }
    installer.record(child.pid ?? null);
    return child;
  };
  /**
   * A package manager's own exit does not mean its install is over: `npm ci` spawns postinstall writers
   * that outlive it, and one of those rewriting node_modules is exactly what the claim exists to keep a
   * copy away from. So the group, not the direct child, decides when the install is done.
   */
  const awaitSpawnedWork = async (what: string): Promise<RefreshFailure | null> => {
    const settled = await installer.settle();
    if (settled.settled) return null;
    return {
      code: DEPS_ERROR,
      message: `${what} exited but left a process group running (pid ${settled.pid}) in ${root} after ${formatElapsed(settled.waitedMs)}, so Stim cannot tell that it finished writing.`,
      lines: [],
      remedy: `Stop what pid ${settled.pid} leads (\`ps -g ${settled.pid}\`, then \`kill -TERM -${settled.pid}\`) and run warm again. The warm claim stays held until that group exits, so no copy reads a half-written tree in the meantime.`,
    };
  };

  const before = resolveFullRef(root, 'HEAD') ?? '';
  if (inspectOnly) {
    if (!remoteUpstreamIsCurrent(root, branch)) return { mutation: 'fetch upstream' };
  } else {
    const fetched = gitQuiet(root, ['fetch', '--prune', branchRemote(root, branch)], {
      write: true,
      timeoutMs: FETCH_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetched === null) emit(phaseLine('checkout', 'could not fetch; continuing with the local state'));
  }

  const plan = checkoutPlan(locallyKnownUpstream(root));
  if (plan.kind === 'diverged') return divergedRefusal(root, branch, plan);
  if (inspectOnly && plan.kind === 'fast-forward') {
    return { mutation: `fast-forward ${plan.behind} commit${plan.behind === 1 ? '' : 's'}` };
  }

  // The evidence that an install may be owed has to be durable before HEAD moves: the fast-forward runs
  // the repository's own hooks, and a retry that finds HEAD already moved, a node_modules present and no
  // evidence at all would call that installed.
  const depsBefore = dependencyStates(root, appDir);
  const priorInstalls = new Map(depsBefore.map((entry) => [entry.root, readInstallEvidence(entry.root)]));
  const marked = plan.kind === 'fast-forward' ? depsBefore : [];
  for (const entry of marked) writeInstallEvidence(entry.root, pendingInstallEvidence(entry));
  const restoreMarked = (depsRoot: string) => {
    if (marked.some((entry) => entry.root === depsRoot))
      restoreInstallEvidence(depsRoot, priorInstalls.get(depsRoot) ?? null);
  };

  let head = before;
  if (plan.kind === 'fast-forward') {
    const merged = fastForward(root, plan.upstream);
    if (!merged.ok) {
      return {
        code: 'STIM_MAIN_DIRTY',
        message: `Refusing to refresh ${root}: git could not fast-forward ${branch} to ${plan.upstream}.`,
        lines: merged.lines,
        remedy: 'Clear what git reports in the source checkout, then run warm again.',
      };
    }
    head = resolveFullRef(root, 'HEAD') ?? before;
  }
  emit(checkoutFactLine(branch, plan, head));

  const note = defaultBranchNote(branch, resolveDefaultBranch(root, settings));
  if (note.kind !== 'match') for (const line of note.lines) emit(phaseLine('', line));

  const dependencyRoots = dependencyStates(root, appDir);
  for (const entry of marked)
    if (!dependencyRoots.some((other) => other.root === entry.root)) restoreMarked(entry.root);
  if (!dependencyRoots.length) emit(stepLine('deps', `source ${root}: no lockfile in this repository`, 'skipped'));
  const owed: { dependencies: DependencyState; consumed: InstallEvidence; subject: string }[] = [];
  for (const dependencies of dependencyRoots) {
    const installed = hasInstalledDependencies(dependencies.root, dependencies.installed);
    const depsDir = relative(root, dependencies.root);
    // What the installer is about to consume. Re-reading the files at completion records whatever was
    // committed while the install ran, which is not what got installed.
    const consumed = pendingInstallEvidence(dependencies);
    const deps = depsPlan({
      lockfile: dependencies.lock,
      lockfileChanged: pathChangedBetween(root, before, head, gitPath(depsDir, dependencies.lock)),
      patchesChanged: pathChangedBetween(root, before, head, gitPath(depsDir, 'patches')),
      installed,
      treeProblems:
        dependencies.lock === 'package-lock.json' && installed ? installedNpmTreeProblems(dependencies.root) : null,
      lastInstall: priorInstalls.has(dependencies.root)
        ? (priorInstalls.get(dependencies.root) ?? null)
        : readInstallEvidence(dependencies.root),
      lockHash: consumed.hash || null,
      patchesHash: consumed.patches,
    });
    const depsSubject = `source ${dependencies.root}: ${deps.reason}`;
    if (deps.run) {
      if (inspectOnly) return { mutation: deps.reason };
      owed.push({ dependencies, consumed, subject: depsSubject });
      continue;
    }
    restoreMarked(dependencies.root);
    emit(stepLine('deps', depsSubject, 'skipped'));
  }
  for (const { dependencies, consumed, subject: depsSubject } of owed) {
    writeInstallEvidence(dependencies.root, consumed);
    const runStep = async (command: string, subject: string, remedy: string): Promise<RefreshFailure | null> => {
      const install = await runInstallCommand({
        command,
        cwd: dependencies.root,
        spawnFn: spawn,
        now,
        heartbeatMs,
        onHeartbeat: emit,
      });
      emit(stepLine('deps', subject, `${command} (${formatDuration(install.durationMs)})`));
      const running = await awaitSpawnedWork(`\`${command}\``);
      if (!install.ok) {
        return {
          code: DEPS_ERROR,
          message: String(install.reason),
          lines: install.lastLines,
          remedy: `Run \`cd ${dependencies.root} && ${remedy}\` and fix what it reports, then run warm again.`,
        };
      }
      return running;
    };
    const postinstall = skippedPostinstall(dependencies) ? 'npm run postinstall' : null;
    const installFailure = await runStep(
      dependencies.command,
      depsSubject,
      postinstall ? `${dependencies.command} && ${postinstall}` : dependencies.command,
    );
    if (installFailure) return installFailure;
    if (postinstall) {
      const postinstallFailure = await runStep(
        postinstall,
        `source ${dependencies.root}: ignore-scripts skipped postinstall`,
        postinstall,
      );
      if (postinstallFailure) return postinstallFailure;
    }
    writeInstallEvidence(dependencies.root, {
      ...consumed,
      completed: true,
      treeProblems: dependencies.lock === 'package-lock.json' ? installedNpmTreeProblems(dependencies.root) : null,
    });
  }

  const app = relative(root, appDir) || '.';
  const where = `source ${appDir}: `;
  const ios = iosProject;
  const podState = readPodState(appDir, ios.dir);
  const pods = podsPlan({
    hasIos: existsSync(ios.dir),
    hasPodfile: podState.hasPodfile,
    podfileLockChanged: pathChangedBetween(root, before, head, gitPath(app, ios.relative, 'Podfile.lock')),
    stale: podsAreStale(podState.lockText, podState.manifestText, podState.dir),
    dir: podState.dir,
  });
  if (!pods.run) {
    emit(stepLine('pods', `${where}${pods.reason}`, 'skipped'));
    return null;
  }
  if (inspectOnly) return { mutation: pods.reason };
  const result = await runPodInstall(appDir, null, {
    spawnFn: spawn,
    now,
    heartbeatMs,
    onHeartbeat: emit,
    directory: ios.dir,
  });
  const podCommand = result.command ?? 'pod install';
  emit(
    stepLine(
      'pods',
      `${where}${pods.reason}`,
      result.durationMs === undefined ? podCommand : `${podCommand} (${formatDuration(result.durationMs)})`,
    ),
  );
  for (const podNote of result.notes ?? []) emit(phaseLine('pods', podNote));
  const podsRunning = await awaitSpawnedWork(`\`${podCommand}\``);
  if (!result.ok) {
    return {
      code: result.code ?? DEPS_ERROR,
      message: result.reason ?? '`pod install` failed.',
      lines: result.lastLines ?? [],
      remedy: result.remedy ?? null,
    };
  }
  return podsRunning;
}
