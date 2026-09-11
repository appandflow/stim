import { execFileSync, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Command } from 'commander';
import { workspaceName } from '@stim-cli/core';
import { registerWarm } from '../commands/worktree.ts';
import { acquireWarmClaim, warmClaimPath, warmClaimsDir } from '../engine/warm-claim.ts';
import { exclusiveClaimDir, readClaimSet } from '../ownership-claim.ts';
import { warmWorktreePaths } from '../worktree.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  type DepsInputs,
  type MainCheckoutState,
  checkoutPlan,
  defaultBranchNote,
  depsPlan,
  divergedRefusal,
  mainCheckoutRefusal,
  podsPlan,
} from '../worktree-refresh.ts';
import { goneClaimOwner, makeExitingChild, plantClaim } from './_factories.ts';

let base: string;
let root: string;
let target: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

function commit(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

async function runWarm(cwd: string, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const command = new Command();
    registerWarm(command);
    await command.parseAsync(['warm', ...args], { from: 'user' });
    return { stdout, stderr: stderr.join('\n'), code: process.exitCode || 0 };
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
  }
}

beforeEach(() => {
  base = execFileSync('/bin/sh', ['-c', 'pwd -P'], {
    cwd: mkdtempSync(join(tmpdir(), 'stim-test-refresh-')),
    encoding: 'utf-8',
  }).trim();
  process.env.STIM_HOME = join(base, 'home');
  const origin = join(base, 'origin.git');
  root = join(base, 'main');
  target = join(base, 'linked');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  execFileSync('git', ['clone', '-q', origin, root], { encoding: 'utf-8' });
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitignore', 'node_modules/\nios/Pods/\napps/*/ios/Pods/\n.env*\n.worktrees/\n');
  write(root, 'package.json', '{"name":"refresh-fixture"}\n');
  commit(root, 'fixture');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', '-a');
  git(root, 'worktree', 'add', '-qb', 'linked', target);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  process.exitCode = 0;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

function fallBehind(files: Record<string, string>, message = 'upstream'): string {
  for (const [rel, value] of Object.entries(files)) write(root, rel, value);
  commit(root, message);
  git(root, 'push', '-q', 'origin', 'main');
  const published = git(root, 'rev-parse', 'HEAD');
  git(root, 'reset', '-q', '--hard', 'HEAD~1');
  return published;
}

test('the refresh decisions read off the state without touching git', () => {
  const clean: MainCheckoutState = { branch: 'main', operation: null, dirtyTracked: [], dirtyKnown: true };
  expect(mainCheckoutRefusal('/w/main', clean)).toBe(null);
  expect(mainCheckoutRefusal('/w/main', { ...clean, operation: 'rebase' })).toMatchObject({
    code: 'STIM_MAIN_DIRTY',
    remedy: expect.stringContaining('git -C /w/main rebase --abort'),
  });
  expect(mainCheckoutRefusal('/w/main', { ...clean, operation: 'am' })?.message).toContain('a git am is in progress');
  expect(mainCheckoutRefusal('/w/main', { ...clean, dirtyTracked: ['src/a.ts'] })).toMatchObject({
    code: 'STIM_MAIN_DIRTY',
    lines: ['src/a.ts'],
    remedy: expect.stringContaining('git -C /w/main stash push -u'),
  });
  expect(mainCheckoutRefusal('/w/main', { ...clean, dirtyKnown: false })).toMatchObject({
    code: 'STIM_MAIN_DIRTY',
    message: expect.stringContaining('could not report whether'),
  });
  expect(mainCheckoutRefusal('/w/main', { ...clean, branch: null })).toMatchObject({
    code: 'STIM_MAIN_DETACHED',
    remedy: expect.stringContaining('git -C /w/main checkout <branch>'),
  });

  expect(checkoutPlan(null)).toEqual({ kind: 'no-upstream' });
  expect(checkoutPlan({ name: 'origin/main', ahead: 0, behind: 3 })).toEqual({
    kind: 'fast-forward',
    behind: 3,
    upstream: 'origin/main',
  });
  expect(checkoutPlan({ name: 'origin/main', ahead: 2, behind: 0 })).toEqual({
    kind: 'current',
    ahead: 2,
    upstream: 'origin/main',
  });
  expect(checkoutPlan({ name: 'origin/main', ahead: 2, behind: 3 }).kind).toBe('diverged');
  expect(divergedRefusal('/w/main', 'wip', { ahead: 2, behind: 3, upstream: 'origin/wip' }).code).toBe(
    'STIM_MAIN_DIVERGED',
  );

  const deps = (over: Partial<DepsInputs>): DepsInputs => ({
    lockfile: 'pnpm-lock.yaml',
    lockfileChanged: false,
    installed: true,
    treeValid: null,
    lastInstall: null,
    lockHash: null,
    ...over,
  });
  const installedOf = (over: Partial<DepsInputs['lastInstall'] & object> = {}) => ({
    lock: 'pnpm-lock.yaml',
    hash: 'a',
    completed: true,
    ...over,
  });
  expect(depsPlan(deps({ lockfile: null, installed: false })).run).toBe(false);
  expect(depsPlan(deps({ lockfileChanged: true }))).toEqual({ run: true, reason: 'pnpm-lock.yaml changed' });
  expect(depsPlan(deps({ installed: false }))).toEqual({ run: true, reason: 'no installed dependencies' });
  expect(depsPlan(deps({ lockfile: 'package-lock.json', treeValid: false })).run).toBe(true);
  expect(depsPlan(deps({}))).toEqual({ run: false, reason: 'pnpm-lock.yaml unchanged' });
  expect(depsPlan(deps({ lastInstall: installedOf({ completed: false }), lockHash: 'a' }))).toEqual({
    run: true,
    reason: 'the last install of pnpm-lock.yaml did not finish',
  });
  expect(depsPlan(deps({ lastInstall: installedOf(), lockHash: 'b' }))).toEqual({
    run: true,
    reason: 'pnpm-lock.yaml does not match the last completed install',
  });
  expect(depsPlan(deps({ lastInstall: installedOf({ lock: 'package-lock.json' }), lockHash: 'a' }))).toEqual({
    run: true,
    reason: 'the last completed install was of package-lock.json',
  });
  expect(depsPlan(deps({ lastInstall: installedOf(), lockHash: null })).run).toBe(true);
  expect(depsPlan(deps({ lastInstall: installedOf(), lockHash: 'a' }))).toEqual({
    run: false,
    reason: 'pnpm-lock.yaml matches the last completed install',
  });
  // The ledger outranks what HEAD did in both directions: an unfinished install is re-run even though
  // the lockfile did not move, and a lockfile that moved is left alone when its content is installed.
  expect(depsPlan(deps({ lockfileChanged: false, lastInstall: installedOf({ completed: false }) })).run).toBe(true);
  expect(depsPlan(deps({ lockfileChanged: true, lastInstall: installedOf(), lockHash: 'a' })).run).toBe(false);

  const fresh = { stale: false } as const;
  expect(podsPlan({ hasIos: false, hasPodfile: false, podfileLockChanged: true, stale: fresh })).toEqual({
    run: false,
    reason: 'no ios/ directory',
  });
  expect(podsPlan({ hasIos: true, hasPodfile: false, podfileLockChanged: true, stale: fresh }).run).toBe(false);
  expect(
    podsPlan({ hasIos: true, hasPodfile: true, podfileLockChanged: false, stale: { noPods: true, stale: false } }),
  ).toEqual({ run: false, reason: 'no ios/Pods and no ios/Podfile.lock' });
  expect(podsPlan({ hasIos: true, hasPodfile: true, podfileLockChanged: true, stale: fresh })).toEqual({
    run: true,
    reason: 'ios/Podfile.lock changed',
  });
  expect(
    podsPlan({
      hasIos: true,
      hasPodfile: true,
      podfileLockChanged: false,
      stale: { stale: true, reason: 'ios/Podfile.lock and ios/Pods/Manifest.lock differ' },
    }),
  ).toEqual({ run: true, reason: 'ios/Podfile.lock and ios/Pods/Manifest.lock differ' });
  expect(podsPlan({ hasIos: true, hasPodfile: true, podfileLockChanged: false, stale: fresh })).toEqual({
    run: false,
    reason: 'ios/Podfile.lock unchanged',
  });

  expect(defaultBranchNote('main', 'main')).toEqual({ kind: 'match' });
  expect(defaultBranchNote('wip', 'develop')).toMatchObject({
    kind: 'warn',
    lines: [expect.stringContaining('not the default branch (develop)'), "carry wip's dependencies"],
  });
  expect(defaultBranchNote('wip', null)).toMatchObject({
    kind: 'unknown',
    lines: [expect.any(String), expect.stringContaining('git remote set-head origin -a')],
  });
});

test('--refresh fast-forwards the source checkout, then copies', async () => {
  const published = fallBehind({ 'src/new.ts': 'upstream work\n' });
  write(root, '.env', 'main env');
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toContain(
    `checkout    main 1 commit behind origin/main -> fast-forwarded to ${published.slice(0, 7)}`,
  );
  expect(result.stderr).toContain(`deps        source ${root}: no lockfile in this repository -> skipped`);
  expect(result.stderr).toContain(`pods        source ${root}: no ios/ directory -> skipped`);
  expect(result.stderr).toMatch(/carry {7}complete: 1 ignored entries copied/);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(published);
  expect(git(target, 'branch', '--show-current')).toBe('linked');
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
});

test('--refresh reports a fetch it could not run and continues with the local state', async () => {
  fallBehind({ 'src/new.ts': 'upstream work\n' });
  git(root, 'remote', 'set-url', 'origin', join(base, 'gone.git'));
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('checkout    could not fetch; continuing with the local state');
  expect(result.stderr).toMatch(/checkout {4}main 1 commit behind origin\/main -> fast-forwarded to/);
});

test('--refresh refuses a diverged source checkout without merging or resetting it', async () => {
  fallBehind({ 'src/new.ts': 'upstream work\n' });
  write(root, 'src/local.ts', 'local work\n');
  commit(root, 'local');
  const before = git(root, 'rev-parse', 'HEAD');
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/main is 1 ahead of and 1 behind origin\/main/);
  expect(result.stderr).toContain('failed: STIM_MAIN_DIVERGED');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  expect(result.stderr).not.toMatch(/carry {7}complete/);
});

test('--refresh refuses a dirty source checkout and names the path, but a plain warm still copies it', async () => {
  write(root, 'package.json', '{"name":"edited-in-main"}\n');
  write(root, '.env', 'main env');
  const refused = await runWarm(target, '--refresh');
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/uncommitted changes to tracked files/);
  expect(refused.stderr).toContain('package.json');
  expect(refused.stderr).toContain('failed: STIM_MAIN_DIRTY');
  expect(existsSync(join(target, '.env'))).toBe(false);

  process.exitCode = 0;
  const plain = await runWarm(target);
  expect(plain.code).toBe(0);
  expect(plain.stdout).toEqual([]);
  expect(plain.stderr).toMatch(/carry {7}complete: 1 ignored entries copied, 0 kept, 0 failed/);
  expect(plain.stderr).not.toMatch(/checkout|deps|lock/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
  expect(readFileSync(join(root, 'package.json'), 'utf-8')).toBe('{"name":"edited-in-main"}\n');
});

test('--refresh refuses a source checkout with a merge in progress', async () => {
  git(root, 'checkout', '-qb', 'other');
  write(root, 'package.json', '{"name":"other-side"}\n');
  commit(root, 'other side');
  git(root, 'checkout', '-q', 'main');
  write(root, 'package.json', '{"name":"main-side"}\n');
  commit(root, 'main side');
  expect(() => git(root, 'merge', 'other')).toThrow('Command failed');
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);

  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/a merge is in progress there/);
  expect(result.stderr).toContain('failed: STIM_MAIN_DIRTY');
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
});

test('--refresh refuses a detached source checkout and an untracked file is not a reason to refuse', async () => {
  write(root, 'untracked.txt', 'not a reason\n');
  git(root, 'checkout', '-q', '--detach');
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/HEAD is detached/);
  expect(result.stderr).toContain('failed: STIM_MAIN_DETACHED');

  process.exitCode = 0;
  git(root, 'checkout', '-q', 'main');
  const attached = await runWarm(target, '--refresh');
  expect(attached.code).toBe(0);
  expect(attached.stderr).toContain('checkout    main up to date with origin/main');
});

test('--refresh leaves a branch with no upstream where it is', async () => {
  git(root, 'checkout', '-qb', 'solo');
  const head = git(root, 'rev-parse', 'HEAD');
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(`checkout    solo has no upstream -> left at ${head.slice(0, 7)}`);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
});

test('--refresh warns when the source checkout is not on the default branch, and stays quiet when it is', async () => {
  const onDefault = await runWarm(target, '--refresh');
  expect(onDefault.stderr).not.toMatch(/default branch/);

  process.exitCode = 0;
  git(root, 'checkout', '-qb', 'wip');
  git(root, 'push', '-q', '-u', 'origin', 'wip');
  const onFeature = await runWarm(target, '--refresh');
  expect(onFeature.code).toBe(0);
  expect(onFeature.stderr).toContain('            not the default branch (main); worktrees seeded from this copy');
  expect(onFeature.stderr).toContain("            carry wip's dependencies");
});

test('worktree.defaultBranch outranks origin/HEAD, and neither resolving says why instead of warning', async () => {
  write(root, '.stim.json', '{"worktree":{"defaultBranch":"release"}}');
  const configured = await runWarm(target, '--refresh');
  expect(configured.code).toBe(0);
  expect(configured.stderr).toContain('not the default branch (release)');

  process.exitCode = 0;
  rmSync(join(root, '.stim.json'));
  git(root, 'remote', 'set-head', 'origin', '-d');
  git(root, 'remote', 'remove', 'origin');
  const unknown = await runWarm(target, '--refresh');
  expect(unknown.code).toBe(0);
  expect(unknown.stderr).toMatch(/could not tell the default branch: no worktree.defaultBranch setting and no/);
  expect(unknown.stderr).toContain('git remote set-head origin -a');
});

test.each(['.', 'apps/mobile'])(
  '--refresh names the source dependency root at %s and the invoking app for pods',
  async (dependencyPath) => {
    const depsRoot = join(root, dependencyPath);
    write(depsRoot, 'pnpm-lock.yaml', 'lock v1\n');
    write(root, 'apps/mobile/package.json', '{"name":"mobile"}\n');
    write(root, 'apps/mobile/ios/Podfile', "target 'mobile'\n");
    write(root, 'apps/mobile/ios/Podfile.lock', 'PODFILE CHECKSUM: v1\n');
    write(root, 'apps/other/package.json', '{"name":"other"}\n');
    write(root, 'apps/other/ios/Podfile', "target 'other'\n");
    write(root, 'apps/other/ios/Podfile.lock', 'PODFILE CHECKSUM: v1\n');
    commit(root, 'monorepo');
    git(root, 'push', '-q', 'origin', 'main');
    git(target, 'merge', '-q', '--ff-only', 'main');
    mkdirSync(join(depsRoot, 'node_modules'), { recursive: true });
    write(root, 'apps/mobile/ios/Pods/Manifest.lock', 'PODFILE CHECKSUM: v0\n');
    write(root, 'apps/other/ios/Pods/Manifest.lock', 'PODFILE CHECKSUM: v0\n');
    fallBehind({ [join(dependencyPath, 'pnpm-lock.yaml')]: 'lock v2\n' }, 'bump lockfile');

    const real = getExecutor();
    const spawned: { cmd: string; args: string[]; cwd: unknown }[] = [];
    setExecutor({
      ...real,
      spawn(cmd: string, args: string[], opts: { cwd?: unknown }) {
        spawned.push({ cmd, args, cwd: opts?.cwd });
        return makeExitingChild(0);
      },
    });

    const result = await runWarm(join(target, 'apps', 'mobile'), '--refresh');
    expect(result.code).toBe(0);
    expect(spawned).toEqual([
      { cmd: 'pnpm', args: ['install'], cwd: depsRoot },
      { cmd: 'pod', args: ['install'], cwd: join(root, 'apps', 'mobile', 'ios') },
    ]);
    expect(result.stderr).toContain(`deps        source ${depsRoot}: pnpm-lock.yaml changed -> pnpm install (`);
    expect(result.stderr).toContain(
      `pods        source ${join(root, 'apps', 'mobile')}: ios/Podfile.lock and ios/Pods/Manifest.lock differ -> pod install (`,
    );
    expect(result.stderr).not.toContain(`pods        source ${join(root, 'apps', 'other')}`);
    expect(result.stderr).not.toContain(`deps        source ${target}`);
  },
);

test('a failed install refuses with the code the build path uses and does not copy', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');
  write(root, '.env', 'main env');
  const real = getExecutor();
  setExecutor({ ...real, spawn: () => makeExitingChild(1, 'ERR_PNPM_OUTDATED_LOCKFILE\n') });
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/`pnpm install` failed \(exit code 1\)/);
  expect(result.stderr).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
  expect(result.stderr).toContain('failed: STIM_DEPS_FAILED');
  expect(existsSync(join(target, '.env'))).toBe(false);
});

test('a refresh in flight blocks a plain warm from another app of the same repository', async () => {
  write(root, 'apps/a/package.json', '{"name":"a"}\n');
  write(root, 'apps/b/package.json', '{"name":"b"}\n');
  commit(root, 'apps');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  write(root, '.env', 'main env');

  const held = await acquireWarmClaim({ repositoryRoot: root, phase: 'refresh' });
  const warm = runWarm(join(target, 'apps', 'b'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(existsSync(join(target, '.env'))).toBe(false);
  held.release();
  const result = await warm;
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/lock {8}acquired \(waited \d+m?\d*s for stim worktree warm --refresh pid \d+\)/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
});

test('warms from two apps of one monorepo resolve one claim, keyed on the repository root', async () => {
  write(root, 'apps/a/package.json', '{"name":"a"}\n');
  write(root, 'apps/b/package.json', '{"name":"b"}\n');
  commit(root, 'apps');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  for (const app of ['a', 'b']) {
    expect(warmClaimPath(warmWorktreePaths(join(target, 'apps', app)).root)).toBe(warmClaimPath(root));
  }
  const held = await acquireWarmClaim({ repositoryRoot: root, phase: 'refresh' });
  try {
    expect(readdirSync(warmClaimsDir())).toEqual([basename(warmClaimPath(root))]);
  } finally {
    held.release();
  }
  expect(existsSync(warmClaimPath(root))).toBe(false);
});

function claimedInstaller(): { pid?: number } | null | undefined {
  const dir = exclusiveClaimDir(warmClaimPath(root));
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.endsWith('.child'));
  if (!name) return undefined;
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')).record;
}

test('--refresh records the installer process group it spawned, so its own death cannot free the claim', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');

  const real = getExecutor();
  let duringInstall: { pid?: number } | null | undefined;
  let spawnedPid: number | undefined;
  let leadsItsOwnGroup: unknown;
  setExecutor({
    ...real,
    spawn(_cmd: string, _args: string[], opts: SpawnOptions) {
      leadsItsOwnGroup = opts?.detached;
      const child = real.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], opts);
      spawnedPid = child.pid;
      setTimeout(() => {
        duringInstall = claimedInstaller();
      }, 120);
      return child;
    },
  });
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(leadsItsOwnGroup).toBe(true);
  expect(duringInstall).toEqual({ pid: spawnedPid, processToken: expect.any(String) });
  expect(claimedInstaller()).toBe(undefined);
});

test('an error from the copy itself is not an unavailable claim, and does not start a second copy', async () => {
  write(root, '.env', 'main env');
  mkdirSync(join(root, '.worktreeexclude'), { recursive: true });
  const result = await runWarm(target);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(/lock {8}unavailable/);
  expect(result.stderr.match(/Could not warm this worktree/g)).toHaveLength(1);
  expect(result.stderr).not.toMatch(/carry {7}complete/);
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(existsSync(warmClaimPath(root))).toBe(false);
});

test('a warm claim Stim cannot resolve refuses both paths instead of copying past it', async () => {
  write(root, '.env', 'main env');
  const claim = plantClaim(warmClaimPath(root), 'exclusive', goneClaimOwner(), {
    claimId: 'half-spawned',
    child: { record: null },
  });

  const plain = await runWarm(target);
  expect(plain.code).toBe(1);
  expect(plain.stderr).toContain('failed: STIM_CLAIM_REFUSED');
  expect(plain.stderr).toContain(claim);
  expect(existsSync(join(target, '.env'))).toBe(false);

  process.exitCode = 0;
  const refresh = await runWarm(target, '--refresh');
  expect(refresh.code).toBe(1);
  expect(refresh.stderr).toContain('failed: STIM_CLAIM_REFUSED');
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(existsSync(claim)).toBe(true);
});

test('a retry after a failed install runs it again instead of copying a half-installed node_modules', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');
  write(root, '.env', 'main env');

  const real = getExecutor();
  setExecutor({ ...real, spawn: () => makeExitingChild(1, 'ERR_PNPM_OUTDATED_LOCKFILE\n') });
  const failed = await runWarm(target, '--refresh');
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain('failed: STIM_DEPS_FAILED');

  process.exitCode = 0;
  const spawned: string[] = [];
  setExecutor({
    ...real,
    spawn(cmd: string, args: string[]) {
      spawned.push([cmd, ...args].join(' '));
      return makeExitingChild(0);
    },
  });
  const retried = await runWarm(target, '--refresh');
  expect(retried.code).toBe(0);
  expect(retried.stderr).toContain('checkout    main up to date with origin/main');
  expect(retried.stderr).toContain(
    `deps        source ${root}: the last install of pnpm-lock.yaml did not finish -> pnpm install`,
  );
  expect(spawned).toEqual(['pnpm install']);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');

  process.exitCode = 0;
  spawned.length = 0;
  const settled = await runWarm(target, '--refresh');
  expect(settled.code).toBe(0);
  expect(settled.stderr).toContain(
    `deps        source ${root}: pnpm-lock.yaml matches the last completed install -> skipped`,
  );
  expect(spawned).toEqual([]);
});

test('a plain warm copies without the lock when STIM_HOME cannot be written, and --refresh still refuses', async () => {
  write(root, '.env', 'main env');
  const home = String(process.env.STIM_HOME);
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o500);
  try {
    const plain = await runWarm(target);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toEqual([]);
    expect(plain.stderr).toMatch(/lock {8}unavailable \(.*\); copying without it/);
    expect(plain.stderr).toMatch(/carry {7}complete: 1 ignored entries copied/);
    expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');

    process.exitCode = 0;
    rmSync(join(target, '.env'));
    const refresh = await runWarm(target, '--refresh');
    expect(refresh.code).toBe(1);
    expect(refresh.stderr).toMatch(/Could not warm this worktree/);
    expect(existsSync(join(target, '.env'))).toBe(false);
  } finally {
    chmodSync(home, 0o700);
  }
});

test('a dangling STIM_HOME link permits a plain copy but refuses refresh before changing the source', async () => {
  write(root, '.env', 'main env');
  fallBehind({ 'package.json': '{"name":"updated-fixture"}\n' });
  const before = git(root, 'rev-parse', 'HEAD');
  symlinkSync(join(base, 'missing-home'), String(process.env.STIM_HOME));

  const plain = await runWarm(target);
  expect(plain.code).toBe(0);
  expect(plain.stdout).toEqual([]);
  expect(plain.stderr).toMatch(/lock {8}unavailable \(ENOENT:.*\); copying without it/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');

  rmSync(join(target, '.env'));
  const refresh = await runWarm(target, '--refresh');
  expect(refresh.code).toBe(1);
  expect(refresh.stdout).toEqual([]);
  expect(refresh.stderr).toMatch(/Could not warm this worktree: ENOENT:/);
  expect(refresh.stderr).not.toContain('another process');
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
});

test('a copy that waited for the lock reads the exclusions the refresh left behind, not the ones it started with', async () => {
  write(root, '.env.production', 'secret');
  const held = await acquireWarmClaim({ repositoryRoot: root, phase: 'refresh' });
  const warm = runWarm(target);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(join(root, '.stim.json'), '{"worktree":{"exclude":[".env.production"]}}');
  held.release();
  const result = await warm;
  expect(result.code).toBe(0);
  expect(existsSync(join(target, '.env.production'))).toBe(false);
  expect(result.stderr).toMatch(/carry {7}complete: 0 ignored entries copied/);
});

test('--refresh installs at the repository root when upstream removed the app it was invoked from', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  write(root, 'apps/mobile/package.json', '{"name":"mobile"}\n');
  commit(root, 'monorepo');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  rmSync(join(root, 'apps'), { recursive: true, force: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'drop the mobile app');

  const real = getExecutor();
  const spawned: { cmd: string; cwd: unknown }[] = [];
  setExecutor({
    ...real,
    spawn(cmd: string, _args: string[], opts: { cwd?: unknown }) {
      spawned.push({ cmd, cwd: opts?.cwd });
      return makeExitingChild(0);
    },
  });
  const result = await runWarm(join(target, 'apps', 'mobile'), '--refresh');
  expect(result.code).toBe(0);
  expect(existsSync(join(root, 'apps', 'mobile'))).toBe(false);
  expect(result.stderr).toContain(`deps        source ${root}: pnpm-lock.yaml changed -> pnpm install`);
  expect(spawned).toEqual([{ cmd: 'pnpm', cwd: root }]);
});

test('--refresh refuses a source checkout whose only change is staged, with the working file back at HEAD', async () => {
  write(root, 'package.json', '{"name":"staged"}\n');
  git(root, 'add', 'package.json');
  write(root, 'package.json', '{"name":"refresh-fixture"}\n');
  expect(git(root, 'diff', '--name-only', 'HEAD')).toBe('');
  const before = git(root, 'rev-parse', 'HEAD');

  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/uncommitted changes to tracked files/);
  expect(result.stderr).toContain('package.json');
  expect(result.stderr).toContain('failed: STIM_MAIN_DIRTY');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
});

async function waitUntil<T>(what: string, read: () => T | null | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function installLedgerFile(): string {
  const dir = join(String(process.env.STIM_HOME), 'warm-installs');
  const name = readdirSync(dir).find((entry) => entry.endsWith('.json'));
  if (!name) throw new Error('no install ledger was written');
  return join(dir, name);
}

function installLedger(): { lock: string; hash: string; completed: boolean } {
  return JSON.parse(readFileSync(installLedgerFile(), 'utf-8'));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function liveExclusiveClaim(): boolean {
  return readClaimSet(warmClaimPath(root)).live.some((holder) => holder.mode === 'exclusive');
}

test('a real install whose own child outlives it holds the claim until that child is done writing', async () => {
  const ready = join(base, 'writer.pid');
  const gate = join(base, 'let-the-writer-finish');
  write(
    root,
    'launch.cjs',
    'const { spawn } = require("node:child_process");\n' +
      'const child = spawn(process.execPath, ["worker.cjs"], { stdio: "ignore" });\n' +
      'child.unref();\n',
  );
  write(
    root,
    'worker.cjs',
    [
      'const fs = require("node:fs");',
      'fs.mkdirSync("node_modules", { recursive: true });',
      'fs.writeFileSync("node_modules/value", "PARTIAL");',
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      'const timer = setInterval(() => {',
      `  if (!fs.existsSync(${JSON.stringify(gate)})) return;`,
      '  fs.writeFileSync("node_modules/value", "COMPLETE");',
      '  clearInterval(timer);',
      '}, 20);',
    ].join('\n'),
  );
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'refresh-fixture', version: '1.0.0', scripts: { postinstall: 'node launch.cjs' } })}\n`,
  );
  write(
    root,
    'package-lock.json',
    `${JSON.stringify({
      name: 'refresh-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'refresh-fixture', version: '1.0.0', hasInstallScript: true } },
    })}\n`,
  );
  commit(root, 'a package whose postinstall outlives npm');
  git(root, 'push', '-q', 'origin', 'main');

  const warm = runWarm(target, '--refresh');
  let writer = 0;
  try {
    writer = Number(
      await waitUntil('the postinstall writer', () => (existsSync(ready) ? readFileSync(ready, 'utf-8') : null)),
    );
    // npm is gone the moment its postinstall script returns, and the writer it left behind is not, so the
    // claim and its child record have to survive npm's own exit.
    expect(readFileSync(join(root, 'node_modules', 'value'), 'utf-8')).toBe('PARTIAL');
    expect(liveExclusiveClaim()).toBe(true);
    expect(claimedInstaller()).toMatchObject({ pid: expect.any(Number) });
  } finally {
    writeFileSync(gate, 'go');
  }
  const result = await warm;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain(`deps        source ${root}: no installed dependencies -> npm ci`);
  expect(readFileSync(join(root, 'node_modules', 'value'), 'utf-8')).toBe('COMPLETE');
  expect(readFileSync(join(target, 'node_modules', 'value'), 'utf-8')).toBe('COMPLETE');
  expect(installLedger()).toMatchObject({ lock: 'package-lock.json', completed: true });
  expect(existsSync(warmClaimPath(root))).toBe(false);
  try {
    process.kill(writer, 'SIGKILL');
  } catch {}
}, 60_000);

test('an install Stim could not record is not abandoned, and its claim outlives the failed record', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');
  write(root, '.env', 'main env');

  const real = getExecutor();
  setExecutor({
    ...real,
    spawn(_cmd: string, _args: string[], opts: SpawnOptions) {
      const dir = exclusiveClaimDir(warmClaimPath(root));
      // The spawned process restores the claim directory itself, so the refresh that could not record it
      // can release the claim once the process is gone rather than leaving it for the next warm to reap.
      const child = real.spawn(
        process.execPath,
        ['-e', `setTimeout(() => require("node:fs").chmodSync(${JSON.stringify(dir)}, 0o700), 200)`],
        opts,
      );
      chmodSync(dir, 0o500);
      return child;
    },
  });

  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(
    /lock {8}could not record the install this refresh spawned \(.*\); holding the claim here until it exits/,
  );
  expect(result.stderr).toContain(`deps        source ${root}: pnpm-lock.yaml changed -> pnpm install`);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
  expect(installLedger()).toMatchObject({ completed: true });
  expect(existsSync(warmClaimPath(root))).toBe(false);
});

test('the evidence that an install is owed is written before the fast-forward moves HEAD', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');
  const snapshot = join(base, 'ledger-as-git-saw-it.json');
  const hook = join(root, '.git', 'hooks', 'post-merge');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    `#!/bin/sh\ncat ${JSON.stringify(join(String(process.env.STIM_HOME), 'warm-installs'))}/*.json > ${JSON.stringify(snapshot)} 2>/dev/null || echo '"none"' > ${JSON.stringify(snapshot)}\n`,
  );
  chmodSync(hook, 0o755);

  const real = getExecutor();
  setExecutor({ ...real, spawn: () => makeExitingChild(0) });
  const first = await runWarm(target, '--refresh');
  expect(first.code).toBe(0);
  // The first hook git runs after it moves HEAD already sees the ledger saying the install is unfinished,
  // so a process killed anywhere past this point leaves a retry that installs instead of one that skips.
  const atHook = JSON.parse(readFileSync(snapshot, 'utf-8'));
  expect(atHook).toMatchObject({ lock: 'pnpm-lock.yaml', hash: sha256('lock v1\n'), completed: false });

  process.exitCode = 0;
  writeFileSync(installLedgerFile(), JSON.stringify(atHook));
  const spawned: string[] = [];
  setExecutor({
    ...real,
    spawn(cmd: string, args: string[]) {
      spawned.push([cmd, ...args].join(' '));
      return makeExitingChild(0);
    },
  });
  const retry = await runWarm(target, '--refresh');
  expect(retry.code).toBe(0);
  expect(retry.stderr).toContain('checkout    main up to date with origin/main');
  expect(retry.stderr).toContain(
    `deps        source ${root}: the last install of pnpm-lock.yaml did not finish -> pnpm install`,
  );
  expect(spawned).toEqual(['pnpm install']);
  expect(installLedger()).toMatchObject({ hash: sha256('lock v2\n'), completed: true });
});

test('the ledger records the lockfile the installer read, not the one on disk when it finished', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');

  const real = getExecutor();
  setExecutor({
    ...real,
    spawn() {
      write(root, 'pnpm-lock.yaml', 'lock v3\n');
      commit(root, 'a third lockfile, committed while the install was running');
      return makeExitingChild(0);
    },
  });
  const first = await runWarm(target, '--refresh');
  expect(first.code).toBe(0);
  expect(installLedger()).toEqual({ lock: 'pnpm-lock.yaml', hash: sha256('lock v2\n'), completed: true });

  process.exitCode = 0;
  const spawned: string[] = [];
  setExecutor({
    ...real,
    spawn(cmd: string, args: string[]) {
      spawned.push([cmd, ...args].join(' '));
      return makeExitingChild(0);
    },
  });
  const second = await runWarm(target, '--refresh');
  expect(second.code).toBe(0);
  expect(second.stderr).toContain(
    `deps        source ${root}: pnpm-lock.yaml does not match the last completed install -> pnpm install`,
  );
  expect(spawned).toEqual(['pnpm install']);
  expect(installLedger()).toEqual({ lock: 'pnpm-lock.yaml', hash: sha256('lock v3\n'), completed: true });
});

test('a STIM_HOME that is a regular file degrades a plain warm and still refuses a --refresh', async () => {
  write(root, '.env', 'main env');
  const home = String(process.env.STIM_HOME);
  rmSync(home, { recursive: true, force: true });
  writeFileSync(home, 'not a directory');

  const plain = await runWarm(target);
  expect(plain.code).toBe(0);
  expect(plain.stdout).toEqual([]);
  expect(plain.stderr).toMatch(
    /lock {8}unavailable \(.*: the claim path is a file, not a claim directory\); copying without it/,
  );
  expect(plain.stderr).toMatch(/carry {7}complete: 1 ignored entries copied, 0 kept, 0 failed/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');

  process.exitCode = 0;
  rmSync(join(target, '.env'));
  const refresh = await runWarm(target, '--refresh');
  expect(refresh.code).toBe(1);
  expect(refresh.stderr).toContain('failed: STIM_CLAIM_REFUSED');
  expect(existsSync(join(target, '.env'))).toBe(false);
});

test('a plain warm refuses the tree a real failed install left, and copies once a refresh finishes it', async () => {
  write(
    root,
    'install.cjs',
    [
      'const fs = require("node:fs");',
      'fs.mkdirSync("node_modules", { recursive: true });',
      'fs.writeFileSync("node_modules/value", fs.existsSync("succeed") ? "COMPLETE" : "PARTIAL");',
      'process.exit(fs.existsSync("succeed") ? 0 : 7);',
    ].join('\n'),
  );
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'refresh-fixture', version: '1.0.0', scripts: { postinstall: 'node install.cjs' } })}\n`,
  );
  write(
    root,
    'package-lock.json',
    `${JSON.stringify({
      name: 'refresh-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'refresh-fixture', version: '1.0.0', hasInstallScript: true } },
    })}\n`,
  );
  write(root, '.env', 'main env');
  commit(root, 'an install whose postinstall fails');
  git(root, 'push', '-q', 'origin', 'main');

  const failed = await runWarm(target, '--refresh');
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain('failed: STIM_DEPS_FAILED');
  expect(installLedger()).toMatchObject({ lock: 'package-lock.json', completed: false });
  expect(readFileSync(join(root, 'node_modules', 'value'), 'utf-8')).toBe('PARTIAL');
  expect(existsSync(join(target, 'node_modules'))).toBe(false);

  process.exitCode = 0;
  const refused = await runWarm(target);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toEqual([]);
  expect(refused.stderr).toContain(`the last install of package-lock.json there did not finish`);
  expect(refused.stderr).toContain('stim worktree warm --refresh');
  expect(refused.stderr).toContain('failed: STIM_DEPS_INCOMPLETE');
  expect(refused.stderr).not.toMatch(/carry {7}/);
  expect(existsSync(join(target, 'node_modules'))).toBe(false);
  expect(existsSync(join(target, '.env'))).toBe(false);

  process.exitCode = 0;
  writeFileSync(join(root, 'succeed'), 'yes');
  const reinstalled = await runWarm(target, '--refresh');
  expect(reinstalled.code).toBe(0);
  expect(reinstalled.stderr).toContain(
    `deps        source ${root}: the last install of package-lock.json did not finish -> npm ci`,
  );
  expect(installLedger()).toMatchObject({ lock: 'package-lock.json', completed: true });

  process.exitCode = 0;
  rmSync(join(target, 'node_modules'), { recursive: true, force: true });
  const copied = await runWarm(target);
  expect(copied.code).toBe(0);
  expect(readFileSync(join(target, 'node_modules', 'value'), 'utf-8')).toBe('COMPLETE');
}, 120_000);

test('an incomplete install of a superseded lockfile does not block a copy', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'value'), 'INSTALLED');
  write(root, '.env', 'main env');
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');

  const real = getExecutor();
  setExecutor({ ...real, spawn: () => makeExitingChild(1, 'ERR_PNPM_OUTDATED_LOCKFILE\n') });
  const failed = await runWarm(target, '--refresh');
  expect(failed.code).toBe(1);
  expect(installLedger()).toEqual({ lock: 'pnpm-lock.yaml', hash: sha256('lock v2\n'), completed: false });

  process.exitCode = 0;
  write(root, 'pnpm-lock.yaml', 'lock v3\n');
  commit(root, 'a lockfile whose dependencies were installed by hand since that failure');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain('STIM_DEPS_INCOMPLETE');
  expect(result.stderr).toMatch(/carry {7}complete: 2 ignored entries copied/);
  expect(readFileSync(join(target, 'node_modules', 'value'), 'utf-8')).toBe('INSTALLED');
  expect(installLedger()).toMatchObject({ completed: false });
});

test('a repository with no install ledger copies exactly as it did before the ledger existed', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  commit(root, 'lockfile');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'value'), 'INSTALLED');
  write(root, '.env', 'main env');
  expect(existsSync(join(String(process.env.STIM_HOME), 'warm-installs'))).toBe(false);

  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/carry {7}complete: 2 ignored entries copied, 0 kept, 0 failed/);
  expect(readFileSync(join(target, 'node_modules', 'value'), 'utf-8')).toBe('INSTALLED');
});

test('a warm from a monorepo app reads the ledger of the repository root that owns the lockfile', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  write(root, 'apps/mobile/package.json', '{"name":"mobile"}\n');
  commit(root, 'monorepo');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'value'), 'PARTIAL');
  write(root, '.env', 'main env');
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');

  const real = getExecutor();
  setExecutor({ ...real, spawn: () => makeExitingChild(1, 'ERR_PNPM_OUTDATED_LOCKFILE\n') });
  const failed = await runWarm(join(target, 'apps', 'mobile'), '--refresh');
  expect(failed.code).toBe(1);
  expect(installLedgerFile()).toBe(join(String(process.env.STIM_HOME), 'warm-installs', `${workspaceName(root)}.json`));

  process.exitCode = 0;
  const refused = await runWarm(join(target, 'apps', 'mobile'));
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`Refusing to copy from ${root}`);
  expect(refused.stderr).toContain('failed: STIM_DEPS_INCOMPLETE');
  expect(existsSync(join(target, 'node_modules'))).toBe(false);
});
