import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerWarm } from '../commands/worktree.ts';
import { acquireWarmLock, warmLocksDir } from '../engine/warm-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  type MainCheckoutState,
  checkoutPlan,
  defaultBranchNote,
  depsPlan,
  divergedRefusal,
  mainCheckoutRefusal,
  podsPlan,
} from '../worktree-refresh.ts';
import { makeExitingChild } from './_factories.ts';

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

  expect(depsPlan({ lockfile: null, lockfileChanged: false, installed: false, treeValid: null }).run).toBe(false);
  expect(depsPlan({ lockfile: 'pnpm-lock.yaml', lockfileChanged: true, installed: true, treeValid: null })).toEqual({
    run: true,
    reason: 'pnpm-lock.yaml changed',
  });
  expect(depsPlan({ lockfile: 'pnpm-lock.yaml', lockfileChanged: false, installed: false, treeValid: null })).toEqual({
    run: true,
    reason: 'no installed dependencies',
  });
  expect(
    depsPlan({ lockfile: 'package-lock.json', lockfileChanged: false, installed: true, treeValid: false }).run,
  ).toBe(true);
  expect(depsPlan({ lockfile: 'pnpm-lock.yaml', lockfileChanged: false, installed: true, treeValid: null })).toEqual({
    run: false,
    reason: 'pnpm-lock.yaml unchanged',
  });

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

test('--refresh fast-forwards the main checkout, then copies', async () => {
  const published = fallBehind({ 'src/new.ts': 'upstream work\n' });
  write(root, '.env', 'main env');
  const result = await runWarm(target, '--refresh');
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toContain(
    `checkout    main 1 commit behind origin/main -> fast-forwarded to ${published.slice(0, 7)}`,
  );
  expect(result.stderr).toContain('deps        no lockfile in this repository -> skipped');
  expect(result.stderr).toContain('pods        no ios/ directory -> skipped');
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

test('--refresh refuses a diverged main checkout without merging or resetting it', async () => {
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

test('--refresh refuses a dirty main checkout and names the path, but a plain warm still copies it', async () => {
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

test('--refresh refuses a main checkout with a merge in progress', async () => {
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

test('--refresh refuses a detached main checkout and an untracked file is not a reason to refuse', async () => {
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

test('--refresh warns when the main checkout is not on the default branch, and stays quiet when it is', async () => {
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

test('--refresh installs the moved lockfile at the repository root and the pods of the invoking app only', async () => {
  write(root, 'pnpm-lock.yaml', 'lock v1\n');
  write(root, 'apps/mobile/package.json', '{"name":"mobile"}\n');
  write(root, 'apps/mobile/ios/Podfile', "target 'mobile'\n");
  write(root, 'apps/mobile/ios/Podfile.lock', 'PODFILE CHECKSUM: v1\n');
  write(root, 'apps/other/package.json', '{"name":"other"}\n');
  write(root, 'apps/other/ios/Podfile', "target 'other'\n");
  write(root, 'apps/other/ios/Podfile.lock', 'PODFILE CHECKSUM: v1\n');
  commit(root, 'monorepo');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  write(root, 'apps/mobile/ios/Pods/Manifest.lock', 'PODFILE CHECKSUM: v0\n');
  write(root, 'apps/other/ios/Pods/Manifest.lock', 'PODFILE CHECKSUM: v0\n');
  fallBehind({ 'pnpm-lock.yaml': 'lock v2\n' }, 'bump lockfile');

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
    { cmd: 'pnpm', args: ['install'], cwd: root },
    { cmd: 'pod', args: ['install'], cwd: join(root, 'apps', 'mobile', 'ios') },
  ]);
  expect(result.stderr).toMatch(/deps {8}pnpm-lock\.yaml changed -> pnpm install \(\d+m?\d*s\)/);
  expect(result.stderr).toMatch(
    /pods {8}apps\/mobile: ios\/Podfile\.lock and ios\/Pods\/Manifest\.lock differ -> pod install \(\d+m?\d*s\)/,
  );
  expect(result.stderr).not.toMatch(/pods {8}apps\/other/);
});

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

  const held = await acquireWarmLock({ repositoryRoot: root, mode: 'refresh' });
  const warm = runWarm(join(target, 'apps', 'b'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(existsSync(join(target, '.env'))).toBe(false);
  held.release();
  const result = await warm;
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/lock {8}acquired \(waited \d+m?\d*s for stim worktree warm --refresh pid \d+\)/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
});

test('warms from two apps of one monorepo share a single lock', async () => {
  write(root, 'apps/a/package.json', '{"name":"a"}\n');
  write(root, 'apps/b/package.json', '{"name":"b"}\n');
  commit(root, 'apps');
  git(root, 'push', '-q', 'origin', 'main');
  git(target, 'merge', '-q', '--ff-only', 'main');
  await runWarm(join(target, 'apps', 'a'), '--refresh');
  process.exitCode = 0;
  await runWarm(join(target, 'apps', 'b'), '--refresh');
  expect(readdirSync(warmLocksDir())).toHaveLength(1);
});
