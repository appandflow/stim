import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { getExecutor } from '../exec.ts';
import { removeTemporaryEntry } from '../temporary.ts';

const CARRY_SKIP_BASENAMES = new Set(['.DerivedData', '.DS_Store', '.idea']);

export function isCarrySkipped(rel: string): boolean {
  return (
    /(^|\/)android\/build\/generated\/autolinking(\/|$)/.test(rel) ||
    String(rel)
      .split('/')
      .some((seg) => CARRY_SKIP_BASENAMES.has(seg))
  );
}

// Git reports paths with forward slashes on every platform, including Windows.
function nativePath(path: string): string {
  return sep === '/' ? path : path.replaceAll('/', sep);
}

export function gitCommonDir(cwd: string): string | null {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return out ? nativePath(out.trim()) : null;
}

export function repoRoot(cwd: string): string | null {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  return out ? nativePath(out.trim()) : null;
}

export interface UpstreamState {
  name: string;
  ahead: number;
  behind: number;
}

export function locallyKnownUpstream(projectRoot: string): UpstreamState | null {
  try {
    const name = getExecutor().runFile(
      'git',
      ['-C', projectRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { timeoutMs: 5000 },
    );
    const counts = getExecutor()
      .runFile('git', ['-C', projectRoot, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
        timeoutMs: 5000,
      })
      .trim()
      .split(/\s+/)
      .map(Number);
    const ahead = counts[0] ?? NaN;
    const behind = counts[1] ?? NaN;
    if (!name || !Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
    return { name, ahead, behind };
  } catch {
    return null;
  }
}

export function warmWorktreePaths(cwd: string): { root: string; target: string; common: string } {
  const currentRoot = repoRoot(cwd);
  if (!currentRoot) throw new Error('Not a git repository.');
  const target = realpathSync(currentRoot);
  const source = resolveSourceCheckout(target);
  if ('refusal' in source) throw new Error(source.refusal);
  const current = source.entries.find((entry) => canonicalPath(entry.path) === target);
  if (!current) throw new Error('Could not identify the linked worktree and its source checkout.');
  const root = realpathSync(source.path);
  if (root === target) {
    throw new Error('Run stim worktree warm from a linked worktree, not the source checkout.');
  }
  const sourceRoot = repoRoot(root);
  const sourceCommon = gitCommonDir(root);
  const targetCommon = gitCommonDir(target);
  if (
    !sourceRoot ||
    realpathSync(sourceRoot) !== root ||
    !sourceCommon ||
    !targetCommon ||
    realpathSync(sourceCommon) !== realpathSync(targetCommon)
  ) {
    throw new Error('Could not verify that the source checkout belongs to this linked worktree.');
  }
  return { root, target, common: realpathSync(targetCommon) };
}

export function matchesInclude(path: string, patterns: string[] | null | undefined): boolean {
  for (const pattern of patterns || []) {
    const rooted = pattern.startsWith('/');
    const body = rooted ? pattern.slice(1) : pattern;
    const escaped = body
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\*\*\//g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]+')
      .replace(/::GLOBSTAR::/g, '(?:.*/)?')
      .replace(/\\\?/g, '[^/]');
    const anchor = rooted ? '^' : '(^|/)';
    const re = new RegExp(`${anchor}${escaped}$`);
    if (re.test(path)) return true;
  }
  return false;
}

export function readWorktreeExclude(root: string): string[] | null {
  return readPatternFile(join(root, '.worktreeexclude'));
}

function readPatternFile(p: string): string[] | null {
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function nestedWorktreePaths(root: string): string[] {
  const source = canonicalPath(root);
  const paths = new Set<string>();
  const out = getExecutor().runFileQuiet('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  if (out === null) {
    throw new Error('Could not list Git worktrees. Refusing to carry ignored files.');
  }
  for (const entry of parseWorktrees(out)) {
    const rel = relative(source, canonicalPath(entry.path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    paths.add(rel.split(sep).join('/'));
  }
  return [...paths];
}

function overlapsNestedWorktree(rel: string, nestedPaths: string[]): boolean {
  const path = String(rel).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return nestedPaths.some(
    (nested) => path === nested || path.startsWith(`${nested}/`) || nested.startsWith(`${path}/`),
  );
}

export function listTrackedPaths(dir: string): string[] | null {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'ls-files', '-z']);
  if (out === null) return null;
  return out.split('\0').filter(Boolean);
}

interface TrackedGuard {
  known: boolean;
  covers(rel: string): boolean;
}

function trackedGuard(dir: string): TrackedGuard {
  const paths = listTrackedPaths(dir);
  if (paths === null) return { known: false, covers: () => false };
  const entries = new Set(paths);
  const covered = new Set(paths);
  for (const p of paths) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) covered.add(p.slice(0, i));
  }
  return {
    known: true,
    covers: (rel) => {
      if (covered.has(rel)) return true;
      for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
        if (entries.has(rel.slice(0, i))) return true;
      }
      return false;
    },
  };
}

interface SkippedEntry {
  file: string;
  reason: string;
}
interface FailedEntry {
  file: string;
  error: string;
}
interface CarryResult {
  copied: string[];
  skipped: SkippedEntry[];
  failed: FailedEntry[];
}

export function listGitignoredEntries(root: string): string[] {
  const args = [
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    '-z',
  ];
  const out = getExecutor().runFile('git', args);
  if (!out) return [];
  return out
    .split('\0')
    .filter(Boolean)
    .map((e) => (e.endsWith('/') ? e.slice(0, -1) : e));
}

export function listCarryableIgnoredEntries(root: string, patterns: string[] | null | undefined): string[] {
  const nested = nestedWorktreePaths(root);
  return listGitignoredEntries(root).filter(
    (rel) => !isCarrySkipped(rel) && !overlapsNestedWorktree(rel, nested) && !matchesInclude(rel, patterns),
  );
}

interface CloneResult extends CarryResult {
  cloned: boolean;
}

function missingDestinationReason(target: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    const stat = lstatSync(join(target, parent), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return `symlink ancestor: ${parent}`;
    if (stat && !stat.isDirectory()) return `non-directory ancestor: ${parent}`;
  }
  return lstatSync(join(target, rel), { throwIfNoEntry: false }) ? 'exists' : null;
}

function removeCopiedExclusions(path: string, rel: string): void {
  const entries = readdirSync(path, { withFileTypes: true });
  const excluded = entries.filter((entry) => isCarrySkipped(`${rel}/${entry.name}`));
  if (excluded.length > 0) {
    const stat = lstatSync(path);
    chmodSync(path, stat.mode | 0o700);
    try {
      for (const entry of excluded) removeTemporaryEntry(join(path, entry.name));
    } finally {
      utimesSync(path, stat.atime, stat.mtime);
      chmodSync(path, stat.mode);
    }
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory() && !isCarrySkipped(child)) removeCopiedExclusions(join(path, entry.name), child);
  }
}

export function cloneIgnoredEntries({
  root,
  target,
  patterns,
}: {
  root: string;
  target: string;
  patterns: string[] | null | undefined;
}): CloneResult {
  const copied: string[] = [];
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];
  let cloned = true;
  const guard = trackedGuard(target);
  if (!guard.known) throw new Error("Could not list the destination's tracked files.");
  const nested = nestedWorktreePaths(target);
  for (const rel of listCarryableIgnoredEntries(root, patterns)) {
    const from = join(root, rel);
    const to = join(target, rel);
    try {
      const reason = guard.covers(rel)
        ? 'tracked'
        : overlapsNestedWorktree(rel, nested)
          ? 'nested worktree'
          : missingDestinationReason(target, rel);
      if (reason) {
        skipped.push({ file: rel, reason });
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      try {
        getExecutor().runFile('cp', ['-Rc', from, to]);
      } catch {
        removeTemporaryEntry(to);
        getExecutor().runFile('cp', ['-R', from, to]);
        cloned = false;
      }
      if (lstatSync(to).isDirectory()) removeCopiedExclusions(to, rel);
      copied.push(rel);
    } catch (e) {
      failed.push({ file: rel, error: String((e as Error)?.message || e) });
    }
  }
  return { copied, skipped, failed, cloned };
}

export function podsOutOfSync(
  target: string,
  copiedEntries: string[] | null | undefined,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): { dir: string; reason: 'missing' | 'mismatch' }[] {
  const problems: { dir: string; reason: 'missing' | 'mismatch' }[] = [];
  for (const rel of copiedEntries || []) {
    if (rel !== 'Pods' && !rel.endsWith('/Pods')) continue;
    const iosDir = rel === 'Pods' ? '' : rel.slice(0, -'/Pods'.length);
    const manifest = join(target, rel, 'Manifest.lock');
    const podfileLock = join(target, iosDir, 'Podfile.lock');
    if (!existsSync(manifest)) continue;
    if (!existsSync(podfileLock)) {
      problems.push({ dir: iosDir || '.', reason: 'missing' });
      continue;
    }
    try {
      if (read(manifest, 'utf-8') !== read(podfileLock, 'utf-8')) {
        problems.push({ dir: iosDir || '.', reason: 'mismatch' });
      }
    } catch {}
  }
  return problems;
}

const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'];

interface NpmLockfile {
  packages?: Record<string, { version?: string; link?: boolean; optional?: boolean; devOptional?: boolean }>;
}

function npmInstallMatches(wanted: NpmLockfile, installed: NpmLockfile): boolean | null {
  if (!wanted.packages || !installed.packages) return null;
  for (const [key, entry] of Object.entries(wanted.packages)) {
    if (!key.includes('node_modules/') || entry.link) continue;
    const present = installed.packages[key];
    if (!present && (entry.optional || entry.devOptional)) continue;
    if (present?.version !== entry.version) return false;
  }
  return true;
}

function lastYamlDocument(text: string): string {
  return (text.split(/^---$/m).at(-1) ?? '').trim();
}

function yarnClassicInstallMatches(
  lockfile: string,
  integrity: { lockfileEntries?: Record<string, string> },
): boolean | null {
  if (!integrity.lockfileEntries) return null;
  const wanted = [...lockfile.matchAll(/^ {2}resolved "([^"]+)"$/gm)].flatMap((m) => m[1] ?? []);
  if (wanted.length === 0) return null;
  const installed = new Set(Object.values(integrity.lockfileEntries));
  return wanted.every((url) => installed.has(url));
}

// Yarn Berry's node-modules linker records peer-dependent packages under
// virtual locators ("name@virtual:<hash>#npm:1.0.0") and omits packages whose
// yarn.lock `conditions` exclude this platform.
function yarnBerryInstallMatches(lockfile: string, state: string): boolean | null {
  const installed = new Set(
    [...state.matchAll(/^"?([^\s"#][^"]*?)"?:$/gm)].flatMap((m) => m[1]?.replace(/@virtual:[^#]+#/, '@') ?? []),
  );
  let entries = 0;
  for (const entry of lockfile.split(/\n(?=\S)/)) {
    const resolution = /^ {2}resolution: "([^"]+)"$/m.exec(entry)?.[1];
    if (!resolution) continue;
    entries += 1;
    if (installed.has(resolution) || /^ {2}conditions: /m.test(entry)) continue;
    return false;
  }
  return entries === 0 ? null : true;
}

function installedMatchesLockfile(
  dir: string,
  lockfile: string,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): boolean | null {
  const text = (rel: string): string | null => {
    try {
      return read(join(dir, rel), 'utf-8').replaceAll('\r\n', '\n');
    } catch {
      return null;
    }
  };
  const wanted = text(lockfile);
  if (wanted === null) return null;
  try {
    if (lockfile === 'package-lock.json') {
      const installed = text('node_modules/.package-lock.json');
      return installed === null ? null : npmInstallMatches(JSON.parse(wanted), JSON.parse(installed));
    }
    if (lockfile === 'pnpm-lock.yaml') {
      // pnpm writes node_modules/.pnpm/lock.yaml for what it installed, so a
      // --filter or --prod install records part of the lockfile and reads as a mismatch.
      const installed = text('node_modules/.pnpm/lock.yaml');
      return installed === null ? null : lastYamlDocument(wanted) === lastYamlDocument(installed);
    }
    if (lockfile === 'yarn.lock') {
      if (/^__metadata:$/m.test(wanted)) {
        const berry = text('node_modules/.yarn-state.yml');
        return berry === null ? null : yarnBerryInstallMatches(wanted, berry);
      }
      const classic = text('node_modules/.yarn-integrity');
      return classic === null ? null : yarnClassicInstallMatches(wanted, JSON.parse(classic));
    }
  } catch {}
  return null;
}

export interface StaleDependencies {
  dir: string;
  lockfile: string;
  reason: 'installed' | 'lockfile';
}

export function depsOutOfSync(
  root: string,
  target: string,
  copiedEntries: string[] | null | undefined,
  { read = readFileSync }: { read?: typeof readFileSync } = {},
): StaleDependencies[] {
  const problems: StaleDependencies[] = [];
  for (const rel of copiedEntries || []) {
    if (rel !== 'node_modules' && !rel.endsWith('/node_modules')) continue;
    const dir = rel === 'node_modules' ? '' : rel.slice(0, -'/node_modules'.length);
    const name = LOCKFILE_NAMES.find((candidate) => existsSync(join(target, dir, candidate)));
    if (!name) continue;
    const installed = installedMatchesLockfile(join(target, dir), name, { read });
    if (installed === false) {
      problems.push({ dir: dir || '.', lockfile: name, reason: 'installed' });
      continue;
    }
    const source = join(root, dir, name);
    if (installed === true || !existsSync(source)) continue;
    try {
      if (read(source, 'utf-8') !== read(join(target, dir, name), 'utf-8')) {
        problems.push({ dir: dir || '.', lockfile: name, reason: 'lockfile' });
      }
    } catch {}
  }
  return problems;
}

const FINGERPRINT_INPUT_FILES = ['app.json', 'app.config.ts', 'app.config.js', 'app.config.mjs', 'package.json'];

export function dirtyFingerprintFiles(root: string): string[] {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    root,
    'status',
    '--porcelain',
    '--',
    ...FINGERPRINT_INPUT_FILES,
  ]);
  if (out === null || out.trim() === '') return [];
  return out
    .split('\n')
    .map((line) => normalizePorcelainLine(line.trimEnd()))
    .filter((line) => line !== '')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '');
}

export function hasUncommittedWork(dir: string): boolean | null {
  const out = getExecutor().runFileQuiet('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain']);
  if (out === null) return null;
  return out.trim().length > 0;
}

export function dirtyPaths(dir: string, { limit = 10 }: { limit?: number } = {}): string[] {
  const out = getExecutor().runFileQuiet('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain']);
  if (out === null) return [];
  const lines = out
    .split('\n')
    .map((l) => normalizePorcelainLine(l.trimEnd()))
    .filter(Boolean);
  return lines.slice(0, limit);
}

function normalizePorcelainLine(line: string): string {
  if (line === '' || line[2] === ' ') return line;
  return ` ${line}`;
}

export function restoreFile(dir: string, file: string): boolean {
  return getExecutor().runFileQuiet('git', ['-C', dir, 'checkout', '--', file]) !== null;
}

export function isPodInstallChurn(paths: string[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.every((line) => /(?:^|\/)(?:Podfile\.lock|project\.pbxproj)$/.test(line.slice(3).trim()));
}

const SAFE_BRANCH_NAME = /^[A-Za-z0-9@._/-]+$/;

export function unpushedCommits(dir: string): string[] | null {
  const exec = getExecutor();
  const branch = exec.runFileQuiet('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const own = branch === null ? '' : branch.trim();
  const protection =
    own && SAFE_BRANCH_NAME.test(own) ? ['--remotes', `--exclude=${own}`, '--branches'] : ['--remotes'];
  if (!own && exec.runFileQuiet('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD') {
    protection.push('--branches');
  }
  const out = exec.runFileQuiet('git', ['-C', dir, 'log', '--oneline', 'HEAD', '--not', ...protection]);
  if (out === null) return null;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function hasRemote(dir: string): boolean {
  const out = getExecutor().runFileQuiet('git', ['-C', dir, 'remote']);
  return Boolean(out && out.trim().length > 0);
}

export function branchExists(cwd: string, branch: string): boolean {
  const out = getExecutor().runFileQuiet('git', [
    '-C',
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  return Boolean(out);
}

export function resolveFullRef(cwd: string, ref: string): string | null {
  try {
    const out = getExecutor().runFile('git', [
      '-C',
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return out && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

// Windows refuses to delete a directory that is a running process's current
// directory, so `from` names another checkout of the same repository. Git for
// Windows also refuses paths past MAX_PATH (a built android/app/.cxx tree)
// unless core.longpaths is on for the invocation.
export function removeWorktree(
  path: string,
  { from, force = false, platform = process.platform }: { from: string; force?: boolean; platform?: NodeJS.Platform },
): void {
  const args = [
    ...(platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
    '-C',
    from,
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    '--',
    path,
  ];
  getExecutor().runFile('git', args);
}

export function deleteBranch(cwd: string, branch: string, expectedSha: string): void {
  if (!SAFE_BRANCH_NAME.test(branch) || branch.startsWith('-')) {
    throw new Error(`Refusing branch ${JSON.stringify(branch)}: it is not a safe local branch name.`);
  }
  getExecutor().runFile('git', ['-C', cwd, 'update-ref', '-d', `refs/heads/${branch}`, expectedSha]);
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
  prunable?: boolean;
  locked?: boolean;
  bare?: boolean;
}

function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: nativePath(line.slice('worktree '.length)) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}

export function hasPopulatedSubmodules(worktree: string): boolean {
  const modules = getExecutor().runFileQuiet('git', ['-C', worktree, 'rev-parse', '--git-path', 'modules']);
  if (modules && existsSync(resolve(worktree, nativePath(modules)))) return true;
  const staged = getExecutor().runFileQuiet('git', ['-C', worktree, 'ls-files', '--stage', '-z']) ?? '';
  return staged
    .split('\0')
    .some(
      (line) => line.startsWith('160000 ') && existsSync(join(worktree, line.slice(line.indexOf('\t') + 1), '.git')),
    );
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const out = getExecutor().runFileQuiet('git', ['-C', cwd, 'worktree', 'list', '--porcelain']);
  return out ? parseWorktrees(out) : [];
}

function branchOf(head: string): string | undefined {
  return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
}

/**
 * The linked worktrees recorded under a git common dir, read from `worktrees/<id>/gitdir` and `HEAD` without running
 * git or touching the worktree directories, sorted by path. The worktree with the branch the common dir's own `HEAD`
 * names (the main checkout's branch, or a bare repository's source checkout) is left out.
 */
export function linkedWorktreesOnDisk(commonDir: string): WorktreeEntry[] {
  const admin = join(commonDir, 'worktrees');
  let ids: string[];
  let sourceBranch: string | undefined;
  try {
    ids = readdirSync(admin);
    sourceBranch = branchOf(readFileSync(join(commonDir, 'HEAD'), 'utf-8').trim());
  } catch {
    return [];
  }
  return ids
    .flatMap((id) => {
      try {
        const gitdir = readFileSync(join(admin, id, 'gitdir'), 'utf-8').trim();
        const branch = branchOf(readFileSync(join(admin, id, 'HEAD'), 'utf-8').trim());
        if (branch && branch === sourceBranch) return [];
        const path = dirname(resolve(admin, id, nativePath(gitdir)));
        return [branch ? { path, branch } : { path }];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The git common dir of the repository containing `start`, read from `.git` and `commondir` files without running
 * git. Returns null when `start` is missing, unreadable, or not inside a repository.
 */
export function gitCommonDirOnDisk(start: string): string | null {
  try {
    for (let dir = realpathSync.native(start); ; dir = dirname(dir)) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) {
        if (statSync(dotGit).isDirectory()) return realpathSync.native(dotGit);
        const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf-8'))?.[1]?.trim();
        if (!gitdir) return null;
        const linked = resolve(dir, gitdir);
        const commondir = join(linked, 'commondir');
        return realpathSync.native(
          existsSync(commondir) ? resolve(linked, readFileSync(commondir, 'utf-8').trim()) : linked,
        );
      }
      if (dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

export type SourceCheckout = { path: string } | { refusal: string };

export function selectSourceCheckout(entries: WorktreeEntry[], bareHead: string | null): SourceCheckout {
  const first = entries[0];
  if (!first) return { refusal: 'Git lists no worktrees for this repository.' };
  if (!first.bare) return { path: first.path };
  const bare = first.path;
  const checkouts = entries.filter((entry) => !entry.bare && !entry.prunable);
  const listed = checkouts.map((entry) => `${entry.branch ?? 'detached'} (${entry.path})`).join(', ') || 'none';
  const pointHead = `  git -C ${bare} symbolic-ref HEAD refs/heads/<branch>`;
  if (!bareHead) {
    return {
      refusal:
        `The bare repository at ${bare} has a detached HEAD, so Stim cannot tell which worktree is the source checkout. ` +
        `Point HEAD at the source branch, then retry:\n${pointHead}\nChecked-out branches: ${listed}`,
    };
  }
  const matches = checkouts.filter((entry) => entry.branch === bareHead);
  const [only] = matches;
  if (only && matches.length === 1) return { path: only.path };
  if (!only) {
    const stale = entries.find((entry) => entry.prunable && entry.branch === bareHead);
    const beside = checkouts[0] ? dirname(checkouts[0].path) : bare;
    const recreate = stale
      ? `Its worktree at ${stale.path} is missing. Recreate it, then retry:\n` +
        `  git -C ${bare} worktree prune\n  git -C ${bare} worktree add ${stale.path} ${bareHead}\n`
      : `Create one, then retry:\n  git -C ${bare} worktree add ${join(beside, bareHead)} ${bareHead}\n`;
    return {
      refusal:
        `The bare repository at ${bare} points HEAD at ${bareHead}, but no worktree has ${bareHead} checked out, ` +
        `so Stim has no source checkout to copy from. ${recreate}` +
        `Or point HEAD at a branch that is checked out (${listed}):\n${pointHead}`,
    };
  }
  return {
    refusal:
      `The bare repository at ${bare} points HEAD at ${bareHead}, which is checked out in more than one worktree: ` +
      `${matches.map((entry) => entry.path).join(', ')}. Remove the extra worktrees, or point HEAD at a branch ` +
      `checked out once, then retry:\n${pointHead}`,
  };
}

function bareHeadBranch(bare: string): string | null {
  const out = getExecutor().runFileQuiet('git', ['-C', bare, 'symbolic-ref', '--quiet', 'HEAD'])?.trim();
  return out?.startsWith('refs/heads/') ? out.slice('refs/heads/'.length) : null;
}

export function sourceCheckoutOf(entries: WorktreeEntry[]): SourceCheckout {
  const first = entries[0];
  return selectSourceCheckout(entries, first?.bare ? bareHeadBranch(first.path) : null);
}

export function resolveSourceCheckout(cwd: string): { entries: WorktreeEntry[] } & SourceCheckout {
  const entries = listWorktrees(cwd);
  return { entries, ...sourceCheckoutOf(entries) };
}
