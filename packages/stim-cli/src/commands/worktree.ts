import type { StimContext } from '@stim-cli/core';
import { runProcessOperation } from '../cli-operation.ts';
import { operationState } from '../engine/operation-state.ts';
import { existsSync, realpathSync, rmSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, plural, releasedLeaseFact, shortUdid } from '../command-output.ts';
import { isTimeoutError } from '../exec.ts';
import {
  resolveIosProjectDir,
  resolveProjectSettings,
  type IosProjectDir,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  inertSettingWarning,
  unknownSettingKeys,
  type SettingsObject,
} from '../workspace/settings.ts';
import {
  getProject,
  isPathPrefix,
  loadConfig,
  removeProject,
  upsertProject,
  withConfigLockAsync,
} from '../workspace/config.ts';
import type { ReleasedLease } from '../engine/device-lease.ts';
import { podInstallCommand } from '../engine/bundler.ts';
import { relocatePods } from '../workspace/pods-relocate.ts';
import { isMobileProject, findProjectRoot } from '../workspace/project.ts';
import { recordWorkspaceUseAsync } from '../workspace/workspace-state.ts';
import { forgetStatusMeasures } from '../status-measures.ts';
import { reclaimProject, type ReclaimResult } from '../devices/reclaim.ts';
import { claimFailure } from '../ownership-claim.ts';
import { SERVICE_IN_USE, serviceRunningFrom, stimCliEntries, stimCliUseOf } from '../workspace/service-guard.ts';
import {
  archiveWorktreeChanges,
  discardWorktreeArchive,
  worktreeArchiveMismatch,
  type WorktreeArchive,
} from '../workspace/worktree-archive.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../devices/sim-pool.ts';
import { currentDiskLevel, measureDiskAsync } from '../maintenance/measure.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { workspaceLinkLine, workspaceLinks } from '../devices/stim-desktop.ts';
import type { ParkedDevice } from '../devices/teardown.ts';
import { withManagedRemoteWorktreeRemovalLock, withManagedTunnelRemovalLock } from '../engine/tunnel.ts';
import { warmClaimAcquiredLine, withWarmClaim, type WarmClaimWait } from '../engine/warm-claim.ts';
import { trace } from '@stim-cli/core/state';
import { startWarmProgress, type WarmProgress } from '../engine/warm-progress.ts';
import { incompleteInstallRefusal, refreshMainCheckout, type RefreshFailure } from '../workspace/worktree-refresh.ts';
import { readMetroTunnel, readRemoteSession } from '../supervisor/state.ts';
import {
  branchExistsAsync,
  depsOutOfSync,
  deleteBranchAsync,
  cloneIgnoredEntries,
  dirtyPathsAsync,
  gitCommonDirAsync,
  hasRemoteAsync,
  hasPopulatedSubmodulesAsync,
  hasUncommittedWorkAsync,
  isPodInstallChurn,
  listWorktreesAsync,
  sourceCheckoutOf,
  podsOutOfSync,
  readWorktreeExclude,
  removeWorktreeAsync,
  resolveFullRefAsync,
  restoreFileAsync,
  unpushedCommitsAsync,
  warmWorktreePaths,
} from '../workspace/worktree.ts';
import type { WorktreeEntry } from '../workspace/worktree.ts';
import { disposeTrash, moveIgnoredTreesToTrash, restoreTrashedTrees } from '../workspace/worktree-trash.ts';
import { endedPullRequest, pullRequestLookupAsync } from '../workspace/pull-request.ts';
import { discoverXcodeProject } from '../integrations/react-native-build.ts';

interface WorktreeSettings {
  worktree?: { exclude?: string[] };
}

export function dependencyInstallCommand(target: string, dir = '.'): string {
  const installRoot = resolve(target, dir);
  let command = 'npm install';
  if (existsSync(resolve(installRoot, 'pnpm-lock.yaml'))) command = 'pnpm install';
  else if (existsSync(resolve(installRoot, 'yarn.lock'))) command = 'yarn install';
  else if (existsSync(resolve(installRoot, 'bun.lock')) || existsSync(resolve(installRoot, 'bun.lockb')))
    command = 'bun install';
  else if (existsSync(resolve(installRoot, 'package-lock.json'))) command = 'npm ci';
  return `cd '${installRoot.replaceAll("'", "'\\''")}' && ${command}`;
}

function relocateCarriedPods(root: string, target: string, copied: string[], out: (line: string) => void): void {
  const canRelocate = depsOutOfSync(root, target, copied).length === 0;
  for (const rel of copied) {
    if (rel !== 'Pods' && !rel.endsWith('/Pods')) continue;
    const iosDir = rel === 'Pods' ? '' : rel.slice(0, -'/Pods'.length);
    try {
      const result = relocatePods({
        podsDir: join(target, rel),
        podfileLockPath: join(target, iosDir, 'Podfile.lock'),
        sourceRoot: root,
        targetRoot: target,
        canRelocate,
      });
      if (result.ok) {
        out(
          chalk.dim(
            phaseLine(
              'carry',
              result.pods.length > 0
                ? `moved ${rel} to this checkout's path; ${result.pods.join(', ')} checksum depends on the checkout path, so pod install is not needed`
                : `moved ${rel} to this checkout's path; the locks match, so pod install is not needed`,
            ),
          ),
        );
      } else if (result.withheld) {
        out(
          chalk.yellow(
            phaseLine(
              'carry',
              `${rel} names the source checkout's path; removed ${rel}/Manifest.lock so pod install runs`,
            ),
          ),
        );
      }
    } catch (error) {
      out(
        chalk.yellow(
          phaseLine(
            'carry',
            `could not move ${rel} to this checkout's path: ${(error as Error).message}. pod install will run`,
          ),
        ),
      );
    }
  }
}

function reportCarriedStateHealth(root: string, target: string, copied: string[], out: (line: string) => void): void {
  const outOfSync = depsOutOfSync(root, target, copied);
  for (const d of outOfSync.filter((dependency) => dependency.reason === 'installed')) {
    const where = d.dir === '.' ? d.lockfile : `${d.dir}/${d.lockfile}`;
    const modules = d.dir === '.' ? 'node_modules' : `${d.dir}/node_modules`;
    out(
      chalk.yellow(
        phaseLine(
          'carry',
          `carried ${modules} was installed from a different ${d.lockfile} than the ${where} on disk here. node_modules is gitignored and cloned from the source checkout; ${d.lockfile} is tracked, so the two can disagree. Run \`${dependencyInstallCommand(target, d.dir)}\` before building, or pod install and native builds see the wrong package versions.`,
        ),
      ),
    );
  }
  const staleDeps = outOfSync.filter((dependency) => dependency.reason === 'lockfile');
  if (staleDeps.length) {
    const manifests = staleDeps.map((d) => (d.dir === '.' ? d.lockfile : `${d.dir}/${d.lockfile}`)).join(', ');
    const remedies = [...new Set(staleDeps.map((dependency) => dependencyInstallCommand(target, dependency.dir)))];
    out(
      chalk.yellow(
        phaseLine(
          'carry',
          `carried dependencies may be stale: they do not match ${manifests}. Run ${remedies.map((command) => `\`${command}\``).join(' and ')} before building.`,
        ),
      ),
    );
  }
  for (const p of podsOutOfSync(target, copied)) {
    const where = p.dir === '.' ? 'Podfile.lock' : `${p.dir}/Podfile.lock`;
    const pod = podInstallCommand(p.dir === '.' ? target : resolve(target, p.dir, '..'), resolve(target, p.dir));
    out(
      chalk.yellow(
        phaseLine(
          'carry',
          p.reason === 'missing'
            ? `carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} but there is no ${where}. Run \`${pod}\` before building.`
            : `carried ${p.dir === '.' ? 'Pods' : `${p.dir}/Pods`} does not match the ${where} on disk here. Pods are gitignored and cloned; Podfile.lock is tracked, so the two can disagree. Run \`${pod}\` before building, or xcodebuild fails with "sandbox is not in sync" only after every pod has compiled.`,
        ),
      ),
    );
  }
}

function reportRefreshFailure(failure: RefreshFailure, out: (line: string) => void): void {
  out(chalk.red(failure.message));
  for (const line of failure.lines) out(chalk.dim(`  ${line}`));
  if (failure.remedy) out(chalk.dim(failure.remedy));
  out(chalk.red(`failed: ${failure.code}`));
}

function mainCheckoutAppDir(root: string, target: string, cwd: string): string {
  const app = warmedWorkspace(root, target, cwd) ?? findProjectRoot(cwd);
  if (!app) return root;
  const rel = relative(target, app);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return root;
  return resolve(root, rel);
}

/**
 * The app workspace a warm prepares: the nearest app below the worktree root, or else the one app registered in
 * the source checkout, at the same place in this worktree, or else the one registered in this worktree, or else
 * the worktree root when it is the app. A monorepo root can declare react-native without being the app.
 */
export function warmedWorkspace(root: string, target: string, cwd: string): string | null {
  const nearest = findProjectRoot(cwd);
  const app = nearest && isPathPrefix(target, nearest) && isMobileProject(nearest) ? nearest : null;
  if (app && app !== target) return app;
  const registered = Object.keys(loadConfig()?.projects ?? {});
  const appsUnder = (checkout: string): Set<string> => {
    const apps = new Set<string>();
    for (const path of registered) {
      const rel = relative(checkout, path);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      const mapped = resolve(target, rel);
      if (isMobileProject(mapped)) apps.add(mapped);
    }
    return apps;
  };
  const source = appsUnder(root);
  const apps = source.size ? source : appsUnder(target);
  return apps.size === 1 ? [...apps][0]! : app;
}

async function registerWarmedWorkspace(workspace: string, out: (line: string) => void): Promise<void> {
  try {
    await withConfigLockAsync(() => {
      if (!getProject(workspace)) upsertProject(workspace, {});
    });
  } catch (error) {
    out(chalk.yellow(`Could not register ${workspace} for status: ${(error as Error)?.message || String(error)}`));
  }
}

export function registerWarm(worktree: Command): void {
  worktree
    .command('warm')
    .description('Copy missing ignored paths from the source checkout into the current linked worktree.')
    .option(
      '--refresh',
      'Before copying, fast-forward the source checkout to its upstream and install what the new commits moved.',
    )
    .action(async (opts: { refresh?: boolean }) => {
      const { value, interrupted } = await runProcessOperation(process.cwd(), async (operation) => {
        try {
          return await warmWorktreeTarget({ cwd: operation.cwd, refresh: opts.refresh, operation });
        } catch (error) {
          if (!operation.signal.aborted || error instanceof WorkspaceProcessCleanupError) {
            const code = (error as { code?: string })?.code;
            console.error(chalk.red(`Could not warm this worktree: ${(error as Error).message}`));
            const claim = claimFailure(error, `stim worktree warm${opts.refresh ? ' --refresh' : ''}`);
            if (claim) console.error(chalk.dim(claim.remedy));
            if (typeof code === 'string' && code.startsWith('STIM_')) console.error(chalk.red(`failed: ${code}`));
          }
          return { exitCode: 1 };
        }
      });
      if (interrupted !== null) process.exitCode = interrupted;
      else if (value.exitCode) process.exitCode = 1;
    });
}

export async function warmWorktreeTarget(opts: {
  cwd: string;
  refresh?: boolean;
  operation: StimContext;
  beforeWarm?: (workspace: string) => void;
}): Promise<{ exitCode: 0 | 1 }> {
  let exitCode: 0 | 1 = 0;
  const operation = opts.operation;
  const out = (line: string) => operation.output('stderr', `${line}\n`);
  let progress: WarmProgress | null = null;
  let workspace: string | null = null;
  try {
    const { root, target, common } = await warmWorktreePaths(opts.cwd, operation);
    operation.signal.throwIfAborted();
    const app = findProjectRoot(opts.cwd);
    workspace = warmedWorkspace(root, target, opts.cwd);
    const scope = new Set([...reclaimKeys(target), ...(app ? [app] : []), ...(workspace ? [workspace] : [])]);
    for (const key of scope) opts.beforeWarm?.(nativeCanonicalPath(key));
    if (app) await recordWorkspaceUseAsync(app, new Date(), operation.env, opts.cwd, operation.signal);
    if (workspace && workspace !== app)
      await recordWorkspaceUseAsync(workspace, new Date(), operation.env, opts.cwd, operation.signal);
    if (!workspace) {
      out(
        chalk.dim(
          phaseLine(
            'project',
            opts.refresh
              ? 'no single app to register here; --refresh updates only the repository root. Run warm --refresh from the app directory to refresh that app and list it in status'
              : 'no single app to register here; run warm from the app directory to list it in status while it warms',
          ),
        ),
      );
    } else {
      await registerWarmedWorkspace(workspace, out);
      progress = startWarmProgress(workspace, opts.refresh ? 'refresh' : 'copy', {
        note: (line) => out(chalk.yellow(line)),
      });
    }
    const readSettings = (): SettingsObject | null => {
      const settings = resolveSettings({ gitCommonDir: common, repoRoot: root });
      const shapeErrors = settingShapeErrors(settings);
      if (shapeErrors.length) {
        for (const message of shapeErrors) out(chalk.red(message));
        out(chalk.dim(SETTING_SHAPE_REMEDY));
        return null;
      }
      for (const key of unknownSettingKeys(settings)) {
        out(chalk.yellow(inertSettingWarning(settings, key)));
      }
      return settings;
    };
    const copy = async (wait: WarmClaimWait | null): Promise<void> => {
      const state = operationState(operation);
      const wasDraining = state.draining;
      state.draining = true;
      try {
        await withWarmClaim(
          {
            repositoryRoot: target,
            phase: 'copy',
            mode: 'exclusive',
            out,
            signal: operation.signal,
            declareSpawnsFor: operation,
          },
          async (hold) => {
            if (hold.wait.holder) out(warmClaimAcquiredLine(hold.wait));
            operation.signal.throwIfAborted();
            progress?.step('copy');
            if (wait?.holder) out(warmClaimAcquiredLine(wait));
            const incomplete = incompleteInstallRefusal(root, mainCheckoutAppDir(root, target, opts.cwd));
            if (incomplete) {
              reportRefreshFailure(incomplete, out);
              exitCode = 1;
              return;
            }
            const settings = readSettings();
            if (!settings) {
              exitCode = 1;
              return;
            }
            const excluded = readWorktreeExclude(root);
            const patterns = excluded?.length ? excluded : (settings as WorktreeSettings).worktree?.exclude || [];
            const result = await trace.spanAsync('carry ignored entries', () =>
              cloneIgnoredEntries({ root, target, patterns, operation }),
            );
            for (const entry of result.skipped) {
              out(chalk.dim(phaseLine('carry', `kept ${entry.file} (${entry.reason})`)));
            }
            for (const entry of result.failed) {
              out(chalk.yellow(phaseLine('carry', `could not copy ${entry.file}: ${entry.error}`)));
            }
            if (result.copied.length) {
              out(chalk.dim(phaseLine('carry', `copied ${carriedFileList(result.copied)} from ${root}`)));
              relocateCarriedPods(root, target, result.copied, out);
              reportCarriedStateHealth(root, target, result.copied, out);
            }
            out(
              phaseLine(
                'carry',
                `${result.failed.length ? 'incomplete' : 'complete'}: ${result.copied.length} ignored entries copied, ${result.skipped.length} kept, ${result.failed.length} failed`,
              ),
            );
            if (result.failed.length) exitCode = 1;
          },
        );
      } finally {
        state.draining = wasDraining;
      }
    };
    if (opts.refresh) {
      const mutation = await withWarmClaim(
        {
          repositoryRoot: root,
          phase: 'refresh',
          mode: 'shared',
          signal: operation.signal,
          declareSpawnsFor: operation,
          out,
        },
        async (hold) => {
          const settings = readSettings();
          if (!settings) {
            exitCode = 1;
            return null;
          }
          const lines: string[] = [];
          const result = await refreshMainCheckout({
            root,
            appDir: mainCheckoutAppDir(root, target, opts.cwd),
            settings,
            iosProject: appIosProjectDir(mainCheckoutAppDir(root, target, opts.cwd)),
            emit: (line) => lines.push(line),
            inspectOnly: true,
          });
          if (!result || !('mutation' in result)) {
            out(warmClaimAcquiredLine(hold.wait, result ? 'shared' : 'shared (seed current)'));
            for (const line of lines) out(line);
            if (result) {
              reportRefreshFailure(result, out);
              exitCode = 1;
            } else await copy(null);
            return null;
          }
          return result.mutation;
        },
      );
      if (mutation === null) return { exitCode };
      const failure = await withWarmClaim(
        { repositoryRoot: root, phase: 'refresh', out, signal: operation.signal },
        async (hold) => {
          out(warmClaimAcquiredLine(hold.wait, `exclusive (${mutation})`));
          const settings = readSettings();
          if (!settings) {
            exitCode = 1;
            return null;
          }
          return refreshMainCheckout({
            root,
            appDir: mainCheckoutAppDir(root, target, opts.cwd),
            settings,
            iosProject: appIosProjectDir(mainCheckoutAppDir(root, target, opts.cwd)),
            emit: (line) => out(line),
            installer: hold.installer,
          });
        },
      );
      if (failure) {
        reportRefreshFailure(failure, out);
        exitCode = 1;
        return { exitCode };
      }
      if (exitCode) return { exitCode };
    }
    await withWarmClaim(
      { repositoryRoot: root, phase: 'copy', out, signal: operation.signal, declareSpawnsFor: operation },
      (hold) => copy(hold.wait),
    );
  } catch (error) {
    exitCode = 1;
    throw error;
  } finally {
    progress?.finish(!exitCode && !operation.signal.aborted);
    const links = workspace && !exitCode && !operation.signal.aborted ? await workspaceLinks(workspace) : undefined;
    if (links) out(chalk.dim(workspaceLinkLine(links)));
  }
  return { exitCode };
}

function carriedFileList(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown}, +${files.length - 3}` : shown;
}

export function porcelainPath(line: string): string | null {
  const raw = String(line).slice(3).trim();
  if (raw === '') return null;
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.replace(/^"(.*)"$/, '$1');
}

const SAFE_DIFF_PATH = /^[A-Za-z0-9._/-]+$/;

const POD_CHURN_PATH = /(?:^|\/)ios\/(?:Podfile\.lock|[^/]+\.xcodeproj\/project\.pbxproj)$/;
export interface CustomIosDir {
  dir: string;
  project: string | null;
}

function isPodChurn(path: string, iosDirs: readonly CustomIosDir[]): boolean {
  if (POD_CHURN_PATH.test(path)) return true;
  return iosDirs.some(({ dir, project }) => {
    const prefix = dir === '.' ? '' : `${dir}/`;
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : null;
    return rest === 'Podfile.lock' || (project !== null && rest === `${project}.xcodeproj/project.pbxproj`);
  });
}

export function customIosDirs(worktree: string): CustomIosDir[] {
  let root: string;
  try {
    root = realpathSync(worktree);
  } catch {
    return [];
  }
  return Object.keys(loadConfig()?.projects ?? {})
    .filter((path) => isPathPrefix(worktree, path))
    .map((path) => ({ path, ios: appIosProjectDir(path) }))
    .filter(({ ios }) => ios.custom && existsSync(ios.dir))
    .map(({ path, ios }) => ({
      dir: relative(root, ios.dir) || '.',
      project: discoverXcodeProject(path, ios.dir).name ?? null,
    }));
}

function appIosProjectDir(appDir: string): IosProjectDir {
  let settings: SettingsObject | null = null;
  try {
    settings = resolveProjectSettings(appDir).settings;
  } catch {}
  return resolveIosProjectDir(settings, appDir);
}

const WATCHMAN_COOKIE_PATH = /(?:^|\/)\.watchman-cookie-[A-Za-z0-9._-]+$/;

export function excludeWatchmanCookies(lines: string[] | null | undefined): { lines: string[]; cookies: string[] } {
  const kept: string[] = [];
  const cookies: string[] = [];
  for (const line of lines || []) {
    const path = String(line).startsWith('?? ') ? porcelainPath(line) : null;
    if (path && SAFE_DIFF_PATH.test(path) && WATCHMAN_COOKIE_PATH.test(path)) cookies.push(path);
    else kept.push(line);
  }
  return { lines: kept, cookies };
}

interface PodChurnResult {
  lines: string[];
  restore: string[];
}

export function excludePodChurn(
  lines: string[] | null | undefined,
  iosDirs: readonly CustomIosDir[] = [],
): PodChurnResult {
  const kept: string[] = [];
  const restore: string[] = [];
  for (const line of lines || []) {
    const path = porcelainPath(line);
    if (path && String(line).startsWith(' M ') && SAFE_DIFF_PATH.test(path) && isPodChurn(path, iosDirs)) {
      restore.push(path);
      continue;
    }
    kept.push(line);
  }
  if (kept.length) return { lines: lines ? [...lines] : [], restore: [] };
  return { lines: kept, restore };
}

interface MatchedWorktreeEntry extends WorktreeEntry {
  index: number;
}

// On Windows, Node's JS realpath keeps 8.3 short names (C:\Users\RUNNER~1) and
// the caller's letter case, while git reports long names; the native realpath
// resolves both.
function nativeCanonicalPath(path: string): string {
  const missing: string[] = [];
  for (let existing = resolve(path); ; existing = dirname(existing)) {
    try {
      return resolve(realpathSync.native(existing), ...missing);
    } catch {
      if (dirname(existing) === existing) return resolve(path);
      missing.unshift(basename(existing));
    }
  }
}

/** Other worktrees git lists inside `path`, which removing `path` would delete with it. */
export function nestedWorktrees(entries: readonly WorktreeEntry[], path: string): string[] {
  const root = nativeCanonicalPath(path);
  return entries
    .filter((candidate) => !candidate.bare && nativeCanonicalPath(candidate.path) !== root)
    .filter((candidate) => isPathPrefix(root, nativeCanonicalPath(candidate.path)))
    .map((candidate) => candidate.path);
}

export function matchWorktreeEntry(
  entries: WorktreeEntry[] | null | undefined,
  path: string,
): MatchedWorktreeEntry | null {
  let best: MatchedWorktreeEntry | null = null;
  const target = nativeCanonicalPath(path);
  (entries || []).forEach((entry, index) => {
    if (!entry?.path || !isPathPrefix(nativeCanonicalPath(entry.path), target)) return;
    if (!best || entry.path.length > best.path.length) best = { ...entry, index };
  });
  return best;
}

export function removalRemedy(
  dirtyLines: string[] | null | undefined,
  { worktree = '<worktree>' }: { worktree?: string } = {},
): string[] {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const line of dirtyLines || []) {
    if (porcelainPath(line) === null) continue;
    (String(line).startsWith('??') ? untracked : tracked).push(line);
  }

  const lines: string[] = [];
  if (tracked.length) {
    if (isPodInstallChurn(tracked)) {
      lines.push('That is only the files `pod install` rewrites. Restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    } else {
      lines.push('Tracked files were modified -- if a build or a setup script did it, restore them and retry:');
      lines.push(`  git -C ${worktree} checkout -- ${pathArgs(tracked)}`);
    }
  }
  if (untracked.length) {
    lines.push('Untracked files are also present -- `git checkout` cannot clear those. Delete them and retry:');
    lines.push(`  git -C ${worktree} clean -fd ${pathArgs(untracked)}        # or rm them yourself`);
  }
  return lines;
}

function pathArgs(lines: string[] | null | undefined, limit = 5): string {
  const paths = (lines || []).map(porcelainPath).filter((p): p is string => Boolean(p));
  const shown = paths.slice(0, limit).map((p) => (/[\s"'\\$`]/.test(p) ? JSON.stringify(p) : p));
  return `${shown.join(' ')}${paths.length > shown.length ? ' ...' : ''}`;
}

const DIRTY_BLOCKER = 'uncommitted changes or untracked files';

export function removalBlockers({ dirty, unpushed }: { dirty: boolean | null; unpushed: string[] | null }): string[] {
  const blockers: string[] = [];
  if (dirty === null || unpushed === null) {
    blockers.push('could not determine git status; re-run with --force to override');
  }
  if (dirty) blockers.push(DIRTY_BLOCKER);
  if (unpushed && unpushed.length) {
    blockers.push(`${plural(unpushed.length, 'commit')} not on any remote or any other local branch`);
  }
  return blockers;
}

interface SkippedDevice {
  platform?: string;
  name: string;
  udid?: string;
  reason: string;
}

interface RetainedResource extends SkippedDevice {
  project: string;
}

function describeKeptDevice(s: SkippedDevice): string {
  return s.udid && s.udid !== s.name ? `${s.name} (${s.udid})` : s.name;
}

interface ReclaimAllResult {
  dereferenced: string[];
  killedPids: number[];
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  parkedMax: Record<'ios' | 'android', number>;
  skippedDevices: SkippedDevice[];
  keptEntries: string[];
  retainedResources: RetainedResource[];
  reclaimedKeys: string[];
  stoppedSessions: string[];
  stoppedTunnels: string[];
  releasedLeases: ReleasedLease[];
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export function reclaimKeys(rootPath: string): string[] {
  const cfg = loadConfig();
  const keys = new Set([rootPath]);
  const root = nativeCanonicalPath(rootPath);
  if (cfg?.projects) {
    for (const key of Object.keys(cfg.projects)) {
      if (isPathPrefix(rootPath, key) || isPathPrefix(root, nativeCanonicalPath(key))) keys.add(key);
    }
  }
  return [...keys].toSorted();
}

async function withReclaimLocks<T>(
  rootPath: string,
  fn: (lockedKeys: readonly string[]) => Promise<T>,
  operation?: StimContext,
  beforeRemove?: (workspace: string) => void,
): Promise<T> {
  const keys = reclaimKeys(rootPath);
  for (const key of keys) beforeRemove?.(nativeCanonicalPath(key));
  const acquire = (index: number): Promise<T> =>
    index === keys.length
      ? fn(keys)
      : withManagedTunnelRemovalLock(keys[index]!, () => acquire(index + 1), {
          signal: operation?.signal,
          declareSpawnsFor: operation,
        });
  return acquire(0);
}

async function reclaimAll(
  rootPath: string,
  keys: readonly string[] = reclaimKeys(rootPath),
  {
    preserveRootProject = false,
    removedBy,
    operation,
  }: {
    preserveRootProject?: boolean;
    removedBy?: 'worktree-remove' | 'gc' | 'maintenance';
    operation?: StimContext;
  } = {},
): Promise<ReclaimAllResult> {
  const dereferenced: string[] = [];
  const killedPids: number[] = [];
  const deletedDevices: string[] = [];
  const parkedDevices: ParkedDevice[] = [];
  const evictedDevices: ParkedDevice[] = [];
  const poolNotes: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const keptEntries: string[] = [];
  const retainedResources: RetainedResource[] = [];
  const stoppedSessions: string[] = [];
  const stoppedTunnels: string[] = [];
  const releasedLeases: ReleasedLease[] = [];
  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  operation?.signal.throwIfAborted();
  const pressure = currentDiskLevel(operation ? await measureDiskAsync(operation) : undefined);
  for (const key of keys) {
    operation?.signal.throwIfAborted();
    let r: ReclaimResult;
    try {
      r = await reclaimProject(key, {
        archive: removedBy ? { removedBy } : undefined,
        deleteOwnedDevices: true,
        parkOwnedDevices: pressure < 2,
        preserveProjectRecord: preserveRootProject && key === rootPath,
        stopRequester: { by: 'stim worktree remove' },
        operation,
      });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      keptEntries.push(key);
      retainedResources.push({
        name: 'ownership state',
        reason: String((error as Error)?.message || error),
        project: key,
      });
      continue;
    }
    dereferenced.push(...r.dereferenced);
    if (r.killedPid) killedPids.push(r.killedPid);
    deletedDevices.push(...r.deletedDevices);
    parkedDevices.push(...r.parkedDevices);
    evictedDevices.push(...r.evictedDevices);
    poolNotes.push(...r.poolNotes);
    skippedDevices.push(...r.skippedDevices);
    if (r.stoppedSession) stoppedSessions.push(r.stoppedSession);
    if (r.stoppedTunnel) stoppedTunnels.push(r.stoppedTunnel);
    releasedLeases.push(...r.releasedLeases);
    removedWorkspaceDirs.push(...r.removedWorkspaceDirs);
    failedWorkspaceDirs.push(...r.failedWorkspaceDirs);
    if (r.keptEntry) {
      keptEntries.push(key);
      for (const resource of r.failedDevices) retainedResources.push({ ...resource, project: key });
    }
  }
  if (pressure >= 2 && deletedDevices.length)
    poolNotes.push(`disk pressure level ${pressure}: deleted the owned devices instead of parking them`);
  for (const key of keys) {
    if (keptEntries.includes(key)) continue;
    const tunnel = readMetroTunnel(key);
    const managedTunnel = tunnel?.kind === 'managed' ? tunnel : null;
    const remote = readRemoteSession(key);
    if (!managedTunnel && !remote) continue;
    keptEntries.push(key);
    retainedResources.push({
      platform: remote?.platform ?? 'ios',
      name: remote ? `remote session ${remote.sessionId}` : `${managedTunnel?.provider ?? 'managed'} tunnel`,
      reason: 'A remote ownership record appeared during reclaim and is retained for a later cleanup.',
      project: key,
    });
  }
  for (const key of reclaimKeys(rootPath)) {
    if (keys.includes(key) || keptEntries.includes(key)) continue;
    keptEntries.push(key);
    retainedResources.push({
      name: 'new project ownership state',
      reason:
        'The project was registered after removal acquired its locks. Retry removal after the other command finishes.',
      project: key,
    });
  }
  return {
    dereferenced,
    killedPids,
    deletedDevices,
    parkedDevices,
    evictedDevices,
    poolNotes,
    parkedMax: { ios: parkedMaxSetting('ios').max, android: parkedMaxSetting('android').max },
    skippedDevices,
    keptEntries,
    retainedResources,
    reclaimedKeys: [...keys],
    stoppedSessions,
    stoppedTunnels,
    releasedLeases,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}

function poolLines(result: ReclaimAllResult): string[] {
  const lines: string[] = [];
  for (const device of result.parkedDevices) {
    lines.push(
      chalk.dim(
        phaseLine(
          'device',
          `parked ${device.name}${device.platform === 'android' ? '' : ` (${shortUdid(device.udid)})`}`,
        ),
      ),
    );
  }
  for (const device of result.evictedDevices) {
    lines.push(
      chalk.dim(
        phaseLine('device', `deleted ${device.name} (pool over ${result.parkedMax[device.platform ?? 'ios']})`),
      ),
    );
  }
  for (const note of result.poolNotes) lines.push(chalk.yellow(phaseLine('device', note)));
  return lines;
}

function reportRetainedResources(root: string, result: ReclaimAllResult, output: RemovalOutput): void {
  output.error(chalk.red(`Refusing to remove ${root}: Stim could not release owned resources.`));
  for (const resource of result.retainedResources) {
    output.error(chalk.yellow(`  - Stim still tracks ${describeKeptDevice(resource)} for ${resource.project}`));
    output.error(chalk.dim(`    ${resource.reason}`));
  }
  for (const kept of result.keptEntries) {
    if (result.retainedResources.some((resource) => resource.project === kept)) continue;
    output.error(chalk.yellow(`  - retained Stim ownership state for ${kept}`));
  }
  output.error(chalk.dim('Fix the reported cause, then run `stim worktree remove` again.'));
  output.fail();
}

function hasRegisteredProjectUnder(rootPath: string): boolean {
  const cfg = loadConfig();
  return Object.keys(cfg?.projects ?? {}).some((key) => isPathPrefix(rootPath, key));
}

// The registered project at or above `path`, nearest first, never above `root`.
function projectAtOrAbove(root: string, path: string): string | null {
  const here = nativeCanonicalPath(path);
  const keys = Object.keys(loadConfig()?.projects ?? {}).filter(
    (key) =>
      isPathPrefix(nativeCanonicalPath(root), nativeCanonicalPath(key)) && isPathPrefix(nativeCanonicalPath(key), here),
  );
  return keys.toSorted((a, b) => b.length - a.length)[0] ?? null;
}

async function reclaimEnvironment(
  root: string,
  why: string,
  output: RemovalOutput,
  operation?: StimContext,
  beforeRemove?: (workspace: string) => void,
): Promise<void> {
  await withManagedRemoteWorktreeRemovalLock(
    root,
    () =>
      withReclaimLocks(
        root,
        async (lockedKeys) => {
          const result = await reclaimAll(root, lockedKeys, { removedBy: 'worktree-remove', operation });
          for (const line of poolLines(result)) output.error(line);
          for (const device of result.deletedDevices) {
            output.error(chalk.dim(phaseLine('device', `deleted ${device}`)));
          }
          for (const session of result.stoppedSessions) {
            output.error(chalk.dim(phaseLine('device', `stopped remote session ${session}`)));
          }
          for (const tunnel of result.stoppedTunnels) {
            output.error(chalk.dim(phaseLine('lan', `stopped the ${tunnel} tunnel`)));
          }
          for (const lease of result.releasedLeases) {
            output.error(chalk.dim(phaseLine('lease', releasedLeaseFact(lease))));
          }
          for (const pid of result.killedPids) output.error(chalk.dim(phaseLine('metro', `killed pid ${pid}`)));
          for (const dir of result.removedWorkspaceDirs) {
            output.error(chalk.dim(phaseLine('workspace', `removed ${dir}`)));
          }
          for (const dir of result.failedWorkspaceDirs) {
            output.error(chalk.yellow(phaseLine('workspace', `could not remove ${dir}`)));
          }
          if (result.dereferenced.length) {
            output.error(chalk.dim(phaseLine('workspace', `no longer referenced: ${result.dereferenced.join(', ')}`)));
          }
          if (result.keptEntries.length) {
            reportRetainedResources(root, result, output);
            return;
          }
          for (const s of result.skippedDevices) {
            output.error(chalk.yellow(phaseLine('device', `kept ${describeKeptDevice(s)} (${s.reason})`)));
          }
          output.error(chalk.green(`Reclaimed the environment; the working tree stays (${why}).`));
        },
        operation,
        beforeRemove,
      ),
    { signal: operation?.signal, declareSpawnsFor: operation },
  );
}

interface RemovalOutput {
  error: (line: string) => void;
  fail: () => void;
}

const REMOVAL_OUTPUT: RemovalOutput = {
  error: (line) => console.error(line),
  fail: () => {
    process.exitCode = 1;
  },
};

interface RemoveOptions {
  beforeRemove?: (workspace: string) => void;
  output?: RemovalOutput;
  operation?: StimContext;
  removedBy?: 'worktree-remove' | 'gc' | 'maintenance';
  force?: boolean;
  linkedOnly?: boolean;
  guard?: (lockedKeys: readonly string[]) => string[] | Promise<string[]>;
  /** A HEAD whose change gc proved is on the default branch; its local-only commits do not block removal. */
  mergedHead?: string;
  /** The HEAD the caller approved for removal; the worktree is kept when HEAD is anything else under the locks. */
  expectedHead?: string;
  /**
   * Archive uncommitted and untracked files under `$STIM_HOME/archive/worktrees` instead of refusing them; the worktree
   * is kept when the archive cannot be written or verified, or the files change before git removes it.
   */
  archiveDirty?: {
    pullRequest: { number: number; url: string; state: string } | null;
    onArchived: (archive: WorktreeArchive) => void;
  };
}

function blockersOf(inspection: RemovalInspection, opts: RemoveOptions): string[] {
  return opts.archiveDirty ? inspection.blockers.filter((blocker) => blocker !== DIRTY_BLOCKER) : inspection.blockers;
}

interface RemovalInspection {
  dirtyLines: string[];
  podChurn: string[];
  cookies: string[];
  unpushed: string[] | null;
  blockers: string[];
  timedOut?: boolean;
}

export function removalPath(target: string | undefined, cwd: string = process.cwd()): string {
  return canonicalExistingPath(target ?? cwd);
}

// The registry keys a worktree by the path git reports, which is the real
// path. Canonicalize from the deepest ancestor that exists so a symlinked or
// not-yet-created directory yields the same key git will.
function canonicalExistingPath(target: string): string {
  const resolved = resolve(target);
  let existing = resolved;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

async function inspectRemoval(path: string, mergedHead?: string, operation?: StimContext): Promise<RemovalInspection> {
  try {
    return await inspectGit(path, mergedHead, operation);
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    return timedOutInspection(error);
  }
}

function timedOutInspection(error: unknown): RemovalInspection {
  const blocker = `a git safety check timed out: ${error instanceof Error ? error.message : String(error)}`;
  return { dirtyLines: [], podChurn: [], cookies: [], unpushed: null, blockers: [blocker], timedOut: true };
}

async function inspectGit(path: string, mergedHead?: string, operation?: StimContext): Promise<RemovalInspection> {
  const options = { removal: true, env: operation?.env, signal: operation?.signal, declareFor: operation };
  const gitAnswered = await hasUncommittedWorkAsync(path, options);
  const allDirty = gitAnswered ? await dirtyPathsAsync(path, { limit: Infinity }, options) : [];
  const { lines: withoutCookies, cookies } = excludeWatchmanCookies(allDirty ?? []);
  const { lines: dirtyLines, restore: podChurn } = excludePodChurn(withoutCookies, customIosDirs(path));
  const dirty = gitAnswered === null || allDirty === null ? null : dirtyLines.length > 0;
  const unpushed = await unpushedCommitsAsync(path, options);
  const merged = Boolean(mergedHead) && (await resolveFullRefAsync(path, 'HEAD', options)) === mergedHead;
  const blockers = removalBlockers({ dirty, unpushed: merged && unpushed ? [] : unpushed });
  const submodules = await hasPopulatedSubmodulesAsync(path, options);
  if (submodules === null) blockers.push('could not check for initialized submodules; re-run with --force to override');
  else if (submodules) blockers.push('initialized submodules, which git removes only with --force');
  return { dirtyLines, podChurn, cookies, unpushed, blockers };
}

async function printRemovalRefusal(
  path: string,
  inspection: RemovalInspection,
  output: RemovalOutput,
  operation?: StimContext,
): Promise<void> {
  const { blockers, dirtyLines, unpushed } = inspection;
  output.error(chalk.red(`Refusing to remove ${path}:`));
  for (const blocker of blockers) output.error(chalk.red(`  - ${blocker}`));
  if (inspection.timedOut) {
    output.error(chalk.dim('Git did not answer in time, so Stim cannot tell whether the worktree holds unsaved work.'));
    output.error(chalk.dim(`Retry once git responds; check with: git -C ${path} status`));
    output.fail();
    return;
  }
  if (
    unpushed &&
    unpushed.length &&
    !(await hasRemoteAsync(path, { env: operation?.env, signal: operation?.signal }))
  ) {
    output.error(
      chalk.dim(
        '  (no remote is configured for this worktree, so every commit no other local branch reaches counts as unpushed)',
      ),
    );
  }
  for (const line of dirtyLines.slice(0, 10)) output.error(chalk.dim(`      ${line}`));
  if (dirtyLines.length) output.error(chalk.dim(`  (git -C ${path} status -s for the full list)`));
  for (const line of removalRemedy(dirtyLines, { worktree: path })) output.error(chalk.dim(line));
  output.error(chalk.dim('Otherwise: commit or push the branch (only commits found nowhere else are counted,'));
  output.error(chalk.dim("so pushing publishes nothing but this worktree's own work). --force is a last"));
  output.error(chalk.dim('resort -- it discards uncommitted changes and untracked files permanently; committed'));
  output.error(chalk.dim('work stays on the branch.'));
  output.fail();
}

function deleteWatchmanCookies(path: string, cookies: string[]): void {
  for (const cookie of cookies) rmSync(join(path, cookie), { force: true });
}

async function restorePodChurn(
  path: string,
  files: string[],
  output: RemovalOutput,
  operation?: StimContext,
): Promise<void> {
  for (const file of files) {
    if (await restoreFileAsync(path, file, { env: operation?.env, signal: operation?.signal, declareFor: operation })) {
      output.error(chalk.dim(`  restored ${file} (pod install churn; the worktree is being removed)`));
    } else {
      output.error(chalk.yellow(`  could not restore ${file}; git may refuse to remove the worktree`));
    }
  }
}

function printRemovalCleanup(result: ReclaimAllResult, failed: boolean, output: RemovalOutput): void {
  for (const line of poolLines(result)) output.error(line);
  for (const device of result.deletedDevices) {
    output.error(chalk.dim(phaseLine('device', `deleted ${device}`)));
  }
  for (const session of result.stoppedSessions) {
    output.error(chalk.dim(phaseLine('device', `stopped remote session ${session}`)));
  }
  for (const tunnel of result.stoppedTunnels) {
    output.error(chalk.dim(phaseLine('lan', `stopped the ${tunnel} tunnel`)));
  }
  for (const lease of result.releasedLeases) {
    output.error(chalk.dim(phaseLine('lease', releasedLeaseFact(lease))));
  }
  for (const pid of result.killedPids) output.error(chalk.dim(phaseLine('metro', `killed pid ${pid}`)));
  if (!failed) {
    for (const dir of result.removedWorkspaceDirs) output.error(chalk.dim(phaseLine('workspace', `removed ${dir}`)));
  }
  if (result.dereferenced.length) {
    output.error(chalk.dim(phaseLine('workspace', `no longer referenced: ${result.dereferenced.join(', ')}`)));
  }
  for (const skipped of result.skippedDevices) {
    output.error(
      (failed ? chalk.dim : chalk.yellow)(
        phaseLine('device', `kept ${describeKeptDevice(skipped)} (${skipped.reason})`),
      ),
    );
  }
}

export async function removeWorktreeTarget(target: string | undefined, opts: RemoveOptions = {}): Promise<boolean> {
  let removed = false;
  await runRemove(target, opts, () => {
    removed = true;
  });
  return removed;
}

async function runRemove(target: string | undefined, opts: RemoveOptions, onRemoved: () => void): Promise<void> {
  const output = opts.output ?? REMOVAL_OUTPUT;
  try {
    await removeOrRefuse(target, opts, onRemoved, output);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    opts.operation?.signal.throwIfAborted();
    if (!isTimeoutError(error)) throw error;
    await printRemovalRefusal(
      removalPath(target, opts.operation?.cwd),
      timedOutInspection(error),
      output,
      opts.operation,
    );
  }
}

async function removeOrRefuse(
  target: string | undefined,
  opts: RemoveOptions,
  onRemoved: () => void,
  output: RemovalOutput,
): Promise<void> {
  const options = {
    removal: true,
    env: opts.operation?.env,
    signal: opts.operation?.signal,
    declareFor: opts.operation,
  };
  options.signal?.throwIfAborted();
  const poolError = parkedMaxSetting('ios').error || parkedMaxSetting('android').error;
  if (poolError) {
    output.error(chalk.red(poolError));
    output.error(chalk.dim(POOL_SETTING_REMEDY));
    output.fail();
    return;
  }
  let path = removalPath(target, opts.operation?.cwd);
  if (!existsSync(path)) {
    opts.beforeRemove?.(path);
    const pending = getProject(path);
    if (
      pending?.worktreeRemovalComplete === true &&
      pending.worktreeBranchOwned === true &&
      pending.worktreeBranch &&
      pending.worktreeMainRoot &&
      pending.worktreePendingBranchSha
    ) {
      const branch = pending.worktreeBranch;
      const mainRoot = pending.worktreeMainRoot;
      if (!existsSync(mainRoot)) {
        output.error(chalk.red(`Cannot finish branch cleanup for ${path}: source checkout ${mainRoot} is missing.`));
        output.error(chalk.dim(`Delete ${branch} from the repository, then run \`stim gc --delete\`.`));
        output.fail();
        return;
      }
      opts.beforeRemove?.(removalPath(mainRoot));
      if (!(await branchExistsAsync(mainRoot, branch, options))) {
        await withConfigLockAsync(() => removeProject(path));
        output.error(chalk.dim(phaseLine('branch', `${branch} is already absent; cleared its pending cleanup record`)));
        return;
      }
      const checkedOutAt = (await listWorktreesAsync(mainRoot, options)).find(
        (candidate) => candidate.branch === branch && resolve(candidate.path) !== resolve(path),
      )?.path;
      if (checkedOutAt) {
        output.error(chalk.red(`Refusing pending cleanup for ${branch}: it is checked out at ${checkedOutAt}.`));
        output.error(chalk.dim('Switch that worktree to another branch, then retry this command.'));
        output.fail();
        return;
      }
      const currentSha = await resolveFullRefAsync(mainRoot, branch, options);
      if (currentSha !== pending.worktreePendingBranchSha) {
        output.error(
          chalk.red(
            `Refusing pending cleanup for ${branch}: its tip changed from ${pending.worktreePendingBranchSha} to ${currentSha || 'an unknown commit'}.`,
          ),
        );
        output.error(chalk.dim('The branch can contain new work. Inspect it and delete it manually if appropriate.'));
        output.fail();
        return;
      }
      try {
        await deleteBranchAsync(mainRoot, branch, pending.worktreePendingBranchSha, options);
        await withConfigLockAsync(() => removeProject(path));
        output.error(chalk.dim(phaseLine('branch', `deleted ${branch}; cleared its pending cleanup record`)));
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        output.error(chalk.red(`Could not delete branch ${branch}: ${String((error as Error)?.message || error)}`));
        output.error(chalk.dim(`Retry with: stim worktree remove ${path}`));
        output.fail();
      }
      return;
    }
    output.error(chalk.red(`No such worktree: ${path}`));
    output.fail();
    return;
  }

  const worktrees = await listWorktreesAsync(path, options);
  const entry = matchWorktreeEntry(worktrees, path);
  if (!entry) {
    if (!opts.linkedOnly && (await gitCommonDirAsync(path, options)) === null && hasRegisteredProjectUnder(path)) {
      await reclaimEnvironment(path, 'it is not a git repository', output, opts.operation, opts.beforeRemove);
      return;
    }
    output.error(chalk.red(`Refusing to remove ${path}: it is not inside any worktree known to git.`));
    output.error(
      chalk.dim(
        '  Run it from inside the worktree, or pass the worktree root path, e.g. as printed by `git worktree list`.',
      ),
    );
    output.fail();
    return;
  }
  if (entry.bare) {
    output.error(chalk.red(`Refusing to remove ${path}: ${entry.path} is the bare repository, not a worktree.`));
    output.error(chalk.dim('  Pass a worktree path, e.g. as printed by `git worktree list`.'));
    output.fail();
    return;
  }
  const source = sourceCheckoutOf(worktrees);
  if ('refusal' in source) {
    output.error(chalk.red(`Refusing to remove ${path}: ${source.refusal}`));
    output.fail();
    return;
  }
  if (entry.path === source.path && opts.linkedOnly) {
    output.error(chalk.red(`Refusing to remove ${path}: ${entry.path} is the source checkout.`));
    output.fail();
    return;
  }
  if (entry.path === source.path) {
    if (nativeCanonicalPath(entry.path) !== nativeCanonicalPath(path)) {
      const project = projectAtOrAbove(entry.path, path);
      if (!project) {
        output.error(chalk.red(`Refusing to reclaim from ${path}: no Stim project is registered at or above it.`));
        output.error(
          chalk.dim(`  Run it from the project folder, or from ${entry.path} to reclaim every project under it.`),
        );
        output.fail();
        return;
      }
      output.error(
        chalk.dim(`${path} is inside the source checkout ${entry.path}; reclaiming only the project ${project}.`),
      );
      await reclaimEnvironment(project, 'it is the source checkout', output, opts.operation, opts.beforeRemove);
      return;
    }
    await reclaimEnvironment(entry.path, 'it is the source checkout', output, opts.operation, opts.beforeRemove);
    return;
  }
  if (entry.path !== path) {
    output.error(chalk.dim(`${path} is inside the worktree ${entry.path}; removing that.`));
    path = entry.path;
  }
  if (entry.locked) {
    output.error(chalk.red(`Refusing to remove ${path}: git has it locked.`));
    output.error(chalk.dim(`Unlock it, then retry: git -C ${source.path} worktree unlock ${path}`));
    output.fail();
    return;
  }
  const nested = nestedWorktrees(worktrees, entry.path);
  if (nested.length) {
    output.error(chalk.red(`Refusing to remove ${path}: it contains the worktree ${nested.join(', ')}.`));
    output.error(chalk.dim('Remove the nested worktree first, then retry.'));
    output.fail();
    return;
  }

  const service = serviceRunningFrom(path, nativeCanonicalPath);
  if (service) {
    output.error(
      chalk.red(
        service.argument
          ? `Refusing to remove ${path}: it runs the stim-server service ${service.label} (${service.argument}). ${SERVICE_IN_USE.code}`
          : `Refusing to remove ${path}: could not read ${service.plist} to check whether the stim-server service ${service.label} runs from it. ${SERVICE_IN_USE.code}`,
      ),
    );
    output.error(
      chalk.dim(
        `Reinstall the service from another build with \`stim-server service install --label ${service.label}\`, or remove it with \`stim-server service uninstall --label ${service.label}\`, then retry.`,
      ),
    );
    output.fail();
    return;
  }
  const cli = stimCliUseOf(path, nativeCanonicalPath, stimCliEntries(opts.operation?.env));
  if (cli.length) {
    output.error(chalk.red(`Refusing to remove ${path}: ${cli.join('; ')}.`));
    output.error(chalk.dim('Run stim from another checkout or install, or point PATH elsewhere, then retry.'));
    output.fail();
    return;
  }

  const project = getProject(path);
  const branch = entry.branch;
  const ownsBranch = Boolean(branch && project?.worktreeBranchOwned === true && project.worktreeBranch === branch);
  const approvedBranchSha = ownsBranch ? await resolveFullRefAsync(path, 'HEAD', options) : null;
  let mergedHead = opts.mergedHead;
  let inspection = await inspectRemoval(path, mergedHead, opts.operation);
  if (
    inspection.blockers.length &&
    !opts.force &&
    !mergedHead &&
    branch &&
    inspection.unpushed?.length &&
    !inspection.dirtyLines.length
  ) {
    const head = await resolveFullRefAsync(path, 'HEAD', options);
    const pr = head ? endedPullRequest(await pullRequestLookupAsync(opts.operation)(path, branch, head)) : null;
    if (head && pr?.state === 'merged') {
      mergedHead = head;
      inspection = await inspectRemoval(path, mergedHead, opts.operation);
      output.error(
        chalk.dim(`HEAD is in the merged PR #${pr.number} (${pr.url}); its local-only commits stay on GitHub.`),
      );
    }
  }
  if (blockersOf(inspection, opts).length && !opts.force) {
    await printRemovalRefusal(path, inspection, output, opts.operation);
    return;
  }

  const deleteOwnedBranch = Boolean(ownsBranch && approvedBranchSha && inspection.unpushed?.length === 0);
  const retainedBranchReason = !branch
    ? null
    : !ownsBranch
      ? 'Stim did not create it'
      : inspection.unpushed === null
        ? 'Stim could not verify whether it has unique commits'
        : inspection.unpushed.length > 0
          ? `it has ${plural(inspection.unpushed.length, 'unique commit')}`
          : null;
  const branchDeleteCwd = source.path;

  let archive: WorktreeArchive | null = null;
  let gitRemoving = false;
  await withManagedRemoteWorktreeRemovalLock(
    path,
    () =>
      withReclaimLocks(
        path,
        async (lockedKeys) => {
          options.signal?.throwIfAborted();
          if ((await opts.guard?.(lockedKeys))?.length) return;
          options.signal?.throwIfAborted();
          const inspectedHead = await resolveFullRefAsync(path, 'HEAD', options);
          if (opts.expectedHead && inspectedHead !== opts.expectedHead) {
            output.error(chalk.red(`Refusing to remove ${path}: its HEAD moved since it was checked.`));
            output.fail();
            return;
          }
          const current = await inspectRemoval(path, mergedHead, opts.operation);
          if (blockersOf(current, opts).length && !opts.force) {
            await printRemovalRefusal(path, current, output, opts.operation);
            return;
          }
          if (opts.archiveDirty && !opts.force && current.dirtyLines.length) {
            try {
              if (!inspectedHead) throw new Error('its HEAD could not be read');
              archive = await archiveWorktreeChanges({
                path,
                repository: source.path,
                branch: branch ?? null,
                head: inspectedHead,
                pullRequest: opts.archiveDirty.pullRequest,
                operation: opts.operation,
              });
            } catch (error) {
              if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
                throw error;
              opts.operation?.signal.throwIfAborted();
              output.error(
                chalk.red(
                  `Refusing to remove ${path}: could not archive its uncommitted changes: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
                ),
              );
              output.fail();
              return;
            }
          }
          const discardArchive = async (): Promise<void> => {
            if (archive) await discardWorktreeArchive(archive);
          };
          const result = await reclaimAll(path, lockedKeys, {
            preserveRootProject: true,
            removedBy: opts.removedBy ?? 'worktree-remove',
            operation: opts.operation,
          });
          if (result.keptEntries.length) {
            await discardArchive();
            reportRetainedResources(path, result, output);
            return;
          }
          let headMoved = false;
          if (!opts.force) {
            try {
              headMoved = (await resolveFullRefAsync(path, 'HEAD', options)) !== inspectedHead;
            } catch (error) {
              if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
                throw error;
              opts.operation?.signal.throwIfAborted();
              if (!isTimeoutError(error)) throw error;
              await discardArchive();
              await printRemovalRefusal(path, timedOutInspection(error), output, opts.operation);
              output.error(chalk.dim(`The directory and Stim ownership record for ${path} were kept.`));
              printRemovalCleanup(result, true, output);
              return;
            }
          }
          if (headMoved) {
            await discardArchive();
            output.error(chalk.red(`Refusing to remove ${path}: its HEAD moved while its environment was reclaimed.`));
            output.error(chalk.dim(`The directory and Stim ownership record for ${path} were kept.`));
            printRemovalCleanup(result, true, output);
            output.fail();
            return;
          }
          const stale = archive ? await worktreeArchiveMismatch(path, archive, opts.operation) : null;
          if (stale) {
            await discardArchive();
            output.error(chalk.red(`Refusing to remove ${path}: ${stale}.`));
            output.error(chalk.dim(`The directory and Stim ownership record for ${path} were kept.`));
            printRemovalCleanup(result, true, output);
            output.fail();
            return;
          }
          await restorePodChurn(path, current.podChurn, output, opts.operation);
          options.signal?.throwIfAborted();
          deleteWatchmanCookies(path, current.cookies);
          const trash = await moveIgnoredTreesToTrash(path, {
            env: options.env,
            signal: options.signal,
            declareFor: opts.operation,
          });
          gitRemoving = true;
          try {
            await removeWorktreeAsync(path, {
              from: source.path,
              force: opts.force || archive !== null,
              env: options.env,
              signal: options.signal,
              declareFor: opts.operation,
            });
          } catch (error) {
            const unrestored = trash ? await restoreTrashedTrees(trash) : [];
            if (trash && unrestored.length) {
              output.error(
                chalk.yellow(
                  `Could not move ${unrestored.join(', ')} back into ${path}; ${unrestored.length === 1 ? 'it stays' : 'they stay'} in ${trash.dir}, which stim gc keeps while ${path} exists.`,
                ),
              );
            }
            if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
              throw error;
            const message = String((error as Error)?.message || error);
            output.error(chalk.red(`git worktree remove failed: ${message}`));
            if (process.platform === 'win32' && /Permission denied/i.test(message)) {
              output.error(
                chalk.dim(
                  'Another process holds a file or directory inside the worktree. An adb server or emulator started from it keeps its working directory open; `adb kill-server` releases the server, and Sysinternals handle.exe lists other holders.',
                ),
              );
            }
            output.error(chalk.dim(`The directory and Stim ownership record for ${path} were kept.`));
            if (archive) output.error(chalk.dim(`Its uncommitted changes stay archived in ${archive.dir}.`));
            printRemovalCleanup(result, true, output);
            output.fail();
            return;
          }
          if (archive) {
            opts.archiveDirty?.onArchived(archive);
            output.error(
              chalk.dim(
                phaseLine(
                  'archive',
                  `saved ${plural(archive.tracked.length + archive.untracked.length, 'uncommitted file')} to ${archive.dir}; restore: ${archive.restore.join(' && ')}`,
                ),
              ),
            );
          }
          onRemoved();
          try {
            forgetStatusMeasures(path, result.reclaimedKeys);
            const finish = (): void => {
              printRemovalCleanup(result, false, output);
              output.error(chalk.dim(phaseLine('removed', path)));
            };
            if (deleteOwnedBranch && branch) {
              if (!approvedBranchSha) {
                output.error(
                  chalk.yellow(phaseLine('branch', `kept ${branch} (Stim could not record its commit before removal)`)),
                );
                output.fail();
                finish();
                return;
              }
              await withConfigLockAsync(() =>
                upsertProject(path, { worktreeRemovalComplete: true, worktreePendingBranchSha: approvedBranchSha }),
              );
              let checkedOutAt: string | undefined;
              try {
                checkedOutAt = (await listWorktreesAsync(branchDeleteCwd, options)).find(
                  (candidate) => candidate.branch === branch && resolve(candidate.path) !== resolve(path),
                )?.path;
              } catch (error) {
                if (
                  error instanceof WorkspaceProcessCleanupError ||
                  (error instanceof Error && 'reportCleanup' in error)
                )
                  throw error;
                opts.operation?.signal.throwIfAborted();
                if (!isTimeoutError(error)) throw error;
                output.error(
                  chalk.yellow(
                    phaseLine('branch', `kept ${branch} (git did not list the worktrees in time to check it)`),
                  ),
                );
                output.error(chalk.dim(`  Retry: stim worktree remove ${path}`));
                output.fail();
                finish();
                return;
              }
              if (checkedOutAt) {
                output.error(
                  chalk.yellow(phaseLine('branch', `kept ${branch} (it is checked out at ${checkedOutAt})`)),
                );
                output.error(
                  chalk.dim(`  Switch that worktree to another branch, then retry: stim worktree remove ${path}`),
                );
                output.fail();
                finish();
                return;
              }
              try {
                await deleteBranchAsync(branchDeleteCwd, branch, approvedBranchSha, options);
                output.error(chalk.dim(phaseLine('branch', `deleted ${branch}`)));
              } catch (error) {
                if (
                  error instanceof WorkspaceProcessCleanupError ||
                  (error instanceof Error && 'reportCleanup' in error)
                )
                  throw error;
                output.error(
                  chalk.yellow(phaseLine('branch', `kept ${branch} (${String((error as Error)?.message || error)})`)),
                );
                output.error(chalk.dim(`  Retry with: git -C ${branchDeleteCwd} branch -D -- ${branch}`));
                output.fail();
                finish();
                return;
              }
            } else if (branch && retainedBranchReason) {
              output.error(chalk.dim(phaseLine('branch', `kept ${branch} (${retainedBranchReason})`)));
            }
            await withConfigLockAsync(() => removeProject(path));
            finish();
          } finally {
            if (trash) {
              const moved = plural(trash.moved.length, 'ignored directory', 'ignored directories');
              const disposed = await disposeTrash(trash, opts.operation);
              output.error(
                chalk.dim(
                  phaseLine(
                    'trash',
                    disposed === 'background'
                      ? `deleting ${moved} in the background from ${trash.dir}`
                      : disposed === 'deleted'
                        ? `deleted ${moved}`
                        : `left ${moved} in ${trash.dir}; stim gc --delete deletes them`,
                  ),
                ),
              );
            }
          }
        },
        opts.operation,
        opts.beforeRemove,
      ),
    { signal: opts.operation?.signal, declareSpawnsFor: opts.operation },
  ).catch(async (error: unknown) => {
    if (archive && !gitRemoving) await discardWorktreeArchive(archive);
    throw error;
  });
}

export function registerRemove(worktree: Command): void {
  worktree
    .command('remove [target]')
    .description(
      'Remove a worktree, its unused Stim-created branch, build artifacts, owned devices, and Metro port. Defaults to the current workspace. On the source checkout it reclaims the environment only and leaves the tree in place; from a subfolder it reclaims only the project at or above that folder, with the projects nested under it.',
    )
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work or initialized submodules')
    .action(async (target: string | undefined, opts: { force?: boolean }) => {
      await removeWorktreeTarget(target, { force: opts.force });
    });
}

export default function worktreeCommand(program: Command): void {
  const worktree = program.command('worktree').description('Warm and remove Git worktrees');
  registerWarm(worktree);
  registerRemove(worktree);
}
