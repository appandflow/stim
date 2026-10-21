import { processContext } from '../cli-operation.ts';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cloneIgnoredEntries, warmWorktreePaths } from '../workspace/worktree.ts';
import { Command } from 'commander';
import { registerWarm } from '../commands/worktree.ts';
import { workspacePhase } from '../engine/warm-progress.ts';
import { loadConfig, upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { READY_PHASE_MS, readWarmRecord } from '@stim-cli/core/state';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

let base: string;
let root: string;
let target: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-warm-')));
  root = join(base, 'main');
  target = join(base, 'linked');
  process.env.STIM_HOME = join(base, 'home');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitignore', 'node_modules/\nios/Pods/\nios/build/\n.env*\nlocal/\n.worktrees/\n.DerivedData/\n');
  write(root, 'package.json', '{"name":"warm-fixture"}\n');
  write(root, 'ios/Podfile.lock', 'branch pods\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  git(root, 'worktree', 'add', '-qb', 'linked', target);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  process.exitCode = 0;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

async function warm() {
  return await cloneIgnoredEntries({ root, target, patterns: [], operation: processContext(target) });
}

test('missing-only copy preserves existing directories, files, and dangling symlinks wholesale', async () => {
  write(root, 'node_modules/new/index.js', 'source package');
  write(root, '.env', 'source env');
  write(root, '.env.local', 'source local');
  write(target, 'node_modules/own/index.js', 'destination package');
  write(target, '.env', 'destination env');
  symlinkSync('absent-env', join(target, '.env.local'));
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(result.skipped).toHaveLength(3);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('destination env');
  expect(readlinkSync(join(target, '.env.local'))).toBe('absent-env');
  expect(readdirSync(join(target, 'node_modules'))).toEqual(['own']);
}, 30_000);

test('missing-only copy refuses destination symlink ancestors', async () => {
  write(root, 'ios/Pods/Manifest.lock', 'source pods');
  rmSync(join(target, 'ios'), { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(target, 'ios'));
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: 'ios/Pods', reason: 'symlink ancestor: ios' }]);
  expect(readdirSync(outside)).toEqual([]);
}, 30_000);

test('missing-only copy skips registered nested worktrees and their ignored parents on either side', async () => {
  const sourceNested = join(root, '.worktrees', 'source');
  const targetNested = join(target, 'local', 'linked');
  git(root, 'worktree', 'add', '-qb', 'source-nested', sourceNested);
  git(root, 'worktree', 'add', '-qb', 'target-nested', targetNested);
  write(root, '.worktrees/other.txt', 'source sibling');
  write(root, 'local/source.txt', 'must not enter target parent');
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(existsSync(join(target, '.worktrees'))).toBe(false);
  expect(existsSync(join(target, 'local/source.txt'))).toBe(false);
  expect(git(targetNested, 'branch', '--show-current')).toBe('target-nested');
}, 30_000);

test('missing-only copy discards partial clone output before each fallback', async () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  const real = getExecutor();
  setExecutor({
    ...real,
    async runFileAsync(file, args, opts) {
      if (file.includes('stim-clonefile-') || (file === 'cp' && args[0] === '-Rc')) {
        write(args[args.length - 1], `partial-${args.length}`, 'failed clone');
        throw new Error('clone not supported');
      }
      return real.runFileAsync(file, args, opts);
    },
  });
  const result = await warm();
  expect(result.failed).toEqual([]);
  expect(result.cloned).toBe(false);
  expect(result.copied).toEqual(['node_modules']);
  expect(readdirSync(join(target, 'node_modules'))).toEqual(['pkg']);
  expect(readFileSync(join(target, 'node_modules/pkg/index.js'), 'utf-8')).toBe('source package');
}, 30_000);

test('failed direct copies discard partial output so a retry can complete', async () => {
  write(root, 'node_modules/pkg/index.js', 'source package');
  const real = getExecutor();
  setExecutor({
    ...real,
    async runFileAsync(file, args, opts) {
      if (file === 'cp' || file.includes('stim-clonefile-')) {
        write(args[args.length - 1], 'partial', 'incomplete');
        throw new Error('copy failed');
      }
      return real.runFileAsync(file, args, opts);
    },
  });
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(result.failed).toEqual([{ file: 'node_modules', error: 'copy failed' }]);
  expect(existsSync(join(target, 'node_modules'))).toBe(false);
  resetExecutor();
  expect((await warm()).copied).toEqual(['node_modules']);
  expect(readFileSync(join(target, 'node_modules/pkg/index.js'), 'utf-8')).toBe('source package');
}, 30_000);

test.skipIf(process.platform === 'win32')(
  'missing-only copy preserves relative symlinks without linking files back to the source (POSIX symlink and inode semantics; skipped on win32)',
  async () => {
    write(root, 'node_modules/pkg/index.js', 'source package');
    const source = join(root, 'node_modules/pkg/index.js');
    const destination = join(target, 'node_modules/pkg/index.js');
    linkSync(source, join(root, 'node_modules/pkg/sibling.js'));
    symlinkSync('pkg', join(root, 'node_modules/alias'));
    write(base, 'outside/.DerivedData/keep', 'outside data');
    symlinkSync('../../outside', join(root, 'node_modules/outside'));
    symlinkSync('../../../outside', join(root, 'node_modules/pkg/.DerivedData'));
    const result = await warm();
    expect(result.failed).toEqual([]);
    expect(readlinkSync(join(target, 'node_modules/alias'))).toBe('pkg');
    expect(readlinkSync(join(target, 'node_modules/outside'))).toBe('../../outside');
    expect(existsSync(join(target, 'node_modules/pkg/.DerivedData'))).toBe(false);
    expect(readFileSync(join(base, 'outside/.DerivedData/keep'), 'utf-8')).toBe('outside data');
    const published = lstatSync(destination);
    expect(published.ino).not.toBe(lstatSync(source).ino);
    expect(published.nlink).toBe(1);
    expect(lstatSync(join(target, 'node_modules/pkg/sibling.js')).ino).not.toBe(published.ino);
    write(target, 'node_modules/pkg/index.js', 'edited destination');
    expect(readFileSync(source, 'utf-8')).toBe('source package');
    expect(readFileSync(join(target, 'node_modules/pkg/sibling.js'), 'utf-8')).toBe('source package');
    writeFileSync(source, 'edited source');
    expect(readFileSync(destination, 'utf-8')).toBe('edited destination');
  },
  30_000,
);

test.skipIf(process.platform !== 'darwin')(
  'direct cloning preserves source timestamps and clones a directory without a per-file copy',
  async () => {
    write(root, '.env', 'source config');
    write(root, 'node_modules/pkg/index.js', 'source package');
    const real = getExecutor();
    const copiedByCp: string[] = [];
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file === 'cp') copiedByCp.push(args[args.length - 2]);
        return real.runFileAsync(file, args, opts);
      },
    });
    const files = ['.env', 'node_modules/pkg/index.js'];
    for (const rel of files) utimesSync(join(root, rel), new Date('2020-01-01'), new Date('2021-01-01'));
    const before = new Map(files.map((rel) => [rel, lstatSync(join(root, rel))]));
    const result = await warm();
    expect(result.failed).toEqual([]);
    expect(result.cloned).toBe(true);
    expect(copiedByCp).toEqual([join(root, '.env')]);
    for (const [rel, source] of before) {
      const copied = lstatSync(join(target, rel));
      expect(copied.ino).not.toBe(source.ino);
      expect(copied.atimeMs).toBe(source.atimeMs);
      expect(copied.mtimeMs).toBe(source.mtimeMs);
    }
  },
  30_000,
);

async function runWarm(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(`${String(value)}\n`));
  const stream = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const command = new Command();
    registerWarm(command);
    await command.parseAsync(['warm'], { from: 'user' });
    return { stdout, stderr: stderr.join(''), code: process.exitCode || 0 };
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
    stream.mockRestore();
  }
}

test('warm identifies canonical main and linked roots from a symlinked subdirectory', async () => {
  const alias = join(base, 'alias');
  symlinkSync(target, alias);
  expect(await warmWorktreePaths(join(alias, 'ios'))).toEqual({ root, target, common: join(root, '.git') });
}, 30_000);

test('warm rejects the source checkout and non-repositories without changing them', async () => {
  write(root, '.env', 'source env');
  const main = await runWarm(root);
  expect(main.code).toBe(1);
  expect(main.stdout).toEqual([]);
  expect(main.stderr).toMatch(/linked worktree, not the source checkout/);
  process.exitCode = 0;
  const outside = await runWarm(base);
  expect(outside.code).toBe(1);
  expect(outside.stderr).toMatch(/Not a git repository/);
}, 30_000);

test('warm refuses an unregistered target, missing source checkout, or mismatched Git common directory', async () => {
  const real = getExecutor();
  for (const kind of ['unregistered', 'missing main', 'different common']) {
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (kind === 'unregistered' && args.includes('worktree') && args.includes('list')) {
          return `worktree ${root}\nbranch refs/heads/main\n`;
        }
        if (kind === 'missing main' && args.includes('--show-toplevel') && args[args.indexOf('-C') + 1] === root)
          throw new Error('source missing');
        if (
          kind === 'different common' &&
          args.at(-1) === '--git-common-dir' &&
          !args.includes('--git-dir') &&
          args[args.indexOf('-C') + 1] === root
        ) {
          return base;
        }
        return real.runFileAsync(file, args, opts);
      },
    });
    await expect(warmWorktreePaths(target)).rejects.toThrow(/Could not/);
  }
}, 30_000);

test('warm copies main ignored state but preserves the linked branch and tracked edits', async () => {
  write(root, 'node_modules/pkg/index.js', 'main dependency');
  write(root, '.env', 'main env');
  write(root, 'package.json', '{"name":"dirty-main"}\n');
  write(target, 'package.json', '{"name":"dirty-linked"}\n');
  write(target, '.env.local', 'linked local env');
  const result = await runWarm(join(target, 'ios'));
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toMatch(/complete: 2 ignored entries copied/);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('main env');
  expect(readFileSync(join(target, '.env.local'), 'utf-8')).toBe('linked local env');
  expect(readFileSync(join(target, 'package.json'), 'utf-8')).toBe('{"name":"dirty-linked"}\n');
  expect(git(target, 'branch', '--show-current')).toBe('linked');
  expect(existsSync(join(base, 'home/config.json'))).toBe(false);
  expect((await runWarm(target)).stderr).toMatch(/complete: 0 ignored entries copied, 2 kept, 0 failed/);
}, 30_000);

test('warm reads main exclusion settings and lets its nonempty pattern file replace them', async () => {
  write(root, '.env', 'source env');
  write(root, '.env.local', 'source local');
  write(root, '.stim.json', '{"worktree":{"exclude":[".env"]}}');
  write(target, '.stim.json', '{"worktree":{"exclude":[".env.local"]}}');
  const settings = await runWarm(target);
  expect(settings.code).toBe(0);
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(readFileSync(join(target, '.env.local'), 'utf-8')).toBe('source local');
  rmSync(join(target, '.env.local'));
  write(root, '.worktreeexclude', '.env.local\n');
  const patterns = await runWarm(target);
  expect(patterns.code).toBe(0);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('source env');
  expect(existsSync(join(target, '.env.local'))).toBe(false);
}, 30_000);

test('warm reports copy failures with nonzero status and no ready claim', async () => {
  write(root, '.env', 'source env');
  const real = getExecutor();
  setExecutor({
    ...real,
    async runFileAsync(file, args, opts) {
      if (file === 'cp') throw new Error('disk full');
      return real.runFileAsync(file, args, opts);
    },
  });
  const result = await runWarm(target);
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toMatch(/could not copy .env: disk full/);
  expect(result.stderr).toMatch(/incomplete: 0 ignored entries copied, 0 kept, 1 failed/);
  expect(result.stderr).not.toMatch(/ready|warmed/);
}, 30_000);

test('warm refuses unreadable source or destination inventories instead of reporting an empty success', async () => {
  const real = getExecutor();
  for (const kind of ['ignored', 'tracked']) {
    process.exitCode = 0;
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (kind === 'ignored' && args.includes('--ignored')) throw new Error('ignored inventory failed');
        if (kind === 'tracked' && args.includes('ls-files') && !args.includes('--ignored'))
          throw new Error('tracked inventory failed');
        return real.runFileAsync(file, args, opts);
      },
    });
    const result = await runWarm(target);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Could not warm/);
    expect(result.stderr).not.toMatch(/complete:/);
  }
}, 30_000);

test('warm reports carried dependency and Pods lockfile mismatches against the linked branch', async () => {
  write(root, 'package-lock.json', 'main lock');
  write(target, 'package-lock.json', 'linked lock');
  write(root, 'node_modules/pkg/index.js', 'source package');
  write(root, 'ios/Pods/Manifest.lock', 'main pods');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stderr).toMatch(/carried dependencies may be stale.*package-lock.json/);
  expect(result.stderr).toMatch(/carried ios\/Pods does not match/);
  expect(readFileSync(join(target, 'ios/Podfile.lock'), 'utf-8')).toBe('branch pods\n');
}, 30_000);

test('warm reports carried node_modules installed from an older lockfile that both checkouts have moved past', async () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, 'fixtures', 'installed-deps', 'npm', name), 'utf-8');
  write(root, 'package-lock.json', fixture('lockfile.next.txt'));
  write(target, 'package-lock.json', fixture('lockfile.next.txt'));
  write(root, 'node_modules/.package-lock.json', fixture('installed.txt'));
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toMatch(/carried node_modules was installed from a different package-lock.json.*npm ci/);
  expect(result.stderr).not.toMatch(/carried dependencies may be stale/);
}, 30_000);

test('warm copies literal ignored filenames and skips Finder, IDE, jj, and derived data', async () => {
  write(root, '.gitignore', readFileSync(join(root, '.gitignore'), 'utf-8') + '.DS_Store\n.idea/\n.jj/\n');
  write(root, '.jj/repo/op_heads', 'source jj state');
  write(root, 'tracked-app/.idea/codeStyles.xml', 'shared IDE settings');
  git(root, 'add', '-f', 'tracked-app/.idea/codeStyles.xml');
  git(root, 'commit', '-qm', 'tracked IDE settings');
  git(target, 'merge', '--ff-only', 'main');
  expect(readFileSync(join(target, 'tracked-app/.idea/codeStyles.xml'), 'utf-8')).toBe('shared IDE settings');
  write(root, 'tracked-app/.idea/codeStyles.xml', 'local source changes');
  write(root, '.idea/workspace.xml', 'source IDE state');
  write(root, '.DS_Store', 'source Finder metadata');
  const literalName = process.platform === 'win32' ? ".env with 'quotes'" : '.env with "quotes"';
  write(root, literalName, 'literal env');
  write(root, 'node_modules/pkg/.DS_Store', 'nested Finder metadata');
  write(root, 'node_modules/pkg/.DS_Store.keep', 'package data');
  write(root, 'node_modules/pkg/.idea/workspace.xml', 'nested IDE state');
  write(root, 'node_modules/pkg/.idea-extra/keep', 'package IDE data');
  write(root, 'node_modules/pkg/.DerivedData/large', 'skip');
  write(root, 'node_modules/pkg/index.js', 'package');
  const result = await warm();
  expect(result.failed).toEqual([]);
  expect(result.copied).not.toContain('.DS_Store');
  expect(result.copied).not.toContain('.idea');
  expect(result.copied).not.toContain('.jj');
  expect(existsSync(join(target, '.jj'))).toBe(false);
  expect(readFileSync(join(target, literalName), 'utf-8')).toBe('literal env');
  expect(existsSync(join(target, '.DS_Store'))).toBe(false);
  expect(existsSync(join(target, 'node_modules/pkg/.DS_Store'))).toBe(false);
  expect(readFileSync(join(target, 'node_modules/pkg/.DS_Store.keep'), 'utf-8')).toBe('package data');
  expect(existsSync(join(target, '.idea'))).toBe(false);
  expect(existsSync(join(target, 'node_modules/pkg/.idea'))).toBe(false);
  expect(readFileSync(join(target, 'node_modules/pkg/.idea-extra/keep'), 'utf-8')).toBe('package IDE data');
  expect(readFileSync(join(target, 'tracked-app/.idea/codeStyles.xml'), 'utf-8')).toBe('shared IDE settings');
  expect(existsSync(join(target, 'node_modules/pkg/.DerivedData'))).toBe(false);
  expect(readFileSync(join(root, '.DS_Store'), 'utf-8')).toBe('source Finder metadata');
  expect(readFileSync(join(root, 'node_modules/pkg/.DS_Store'), 'utf-8')).toBe('nested Finder metadata');
  expect(readFileSync(join(root, '.idea/workspace.xml'), 'utf-8')).toBe('source IDE state');
  expect(readFileSync(join(root, 'node_modules/pkg/.idea/workspace.xml'), 'utf-8')).toBe('nested IDE state');
  expect(readFileSync(join(root, 'tracked-app/.idea/codeStyles.xml'), 'utf-8')).toBe('local source changes');

  write(target, '.DS_Store', 'destination Finder metadata');
  write(target, 'node_modules/pkg/.DS_Store', 'destination nested metadata');
  write(target, '.idea/workspace.xml', 'destination IDE state');
  write(target, 'node_modules/pkg/.idea/workspace.xml', 'destination nested IDE state');
  expect((await warm()).failed).toEqual([]);
  expect(readFileSync(join(target, '.DS_Store'), 'utf-8')).toBe('destination Finder metadata');
  expect(readFileSync(join(target, 'node_modules/pkg/.DS_Store'), 'utf-8')).toBe('destination nested metadata');
  expect(readFileSync(join(target, '.idea/workspace.xml'), 'utf-8')).toBe('destination IDE state');
  expect(readFileSync(join(target, 'node_modules/pkg/.idea/workspace.xml'), 'utf-8')).toBe(
    'destination nested IDE state',
  );
}, 30_000);

test('warm removes every nested exclusion from a wide, deep carried tree', async () => {
  const dirs: string[] = [];
  for (let a = 0; a < 6; a++)
    for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) dirs.push(`node_modules/p${a}/d${b}/e${c}`);
  for (const dir of dirs) {
    write(root, `${dir}/index.js`, dir);
    write(root, `${dir}/.DS_Store`, 'Finder metadata');
    write(root, `${dir}/.idea/workspace.xml`, 'IDE state');
  }
  const result = await warm();
  expect(result.failed).toEqual([]);
  const left = dirs.filter(
    (dir) => existsSync(join(target, dir, '.DS_Store')) || existsSync(join(target, dir, '.idea')),
  );
  expect(left).toEqual([]);
  expect(dirs.filter((dir) => readFileSync(join(target, dir, 'index.js'), 'utf-8') !== dir)).toEqual([]);
}, 30_000);

test.each(['android/build/', 'apps/mobile/'])(
  'warm excludes generated autolinking from ignored %s',
  async (ignored) => {
    write(root, '.gitignore', `${ignored}\n`);
    const app = ignored.startsWith('apps/') ? 'apps/mobile/' : '';
    const generated = `${app}android/build/generated`;
    write(root, `${generated}/autolinking/autolinking.json`, 'source checkout paths');
    write(root, `${generated}/autolinking/package.json.sha`, 'unchanged checksum');
    write(root, `${generated}/other/output`, 'reusable output');
    write(root, `${generated}/autolinking-extra/keep`, 'unrelated output');
    const result = await warm();
    expect(result.failed).toEqual([]);
    expect(existsSync(join(target, generated, 'autolinking'))).toBe(false);
    expect(readFileSync(join(target, generated, 'other/output'), 'utf8')).toBe('reusable output');
    expect(readFileSync(join(target, generated, 'autolinking-extra/keep'), 'utf8')).toBe('unrelated output');
    expect(readFileSync(join(root, generated, 'autolinking/autolinking.json'), 'utf8')).toBe('source checkout paths');
    write(target, `${generated}/autolinking/autolinking.json`, 'destination checkout paths');
    expect((await warm()).failed).toEqual([]);
    expect(readFileSync(join(target, generated, 'autolinking/autolinking.json'), 'utf8')).toBe(
      'destination checkout paths',
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'missing-only copy preserves executable file modes (POSIX file modes; skipped on win32)',
  async () => {
    write(root, 'node_modules/pkg/bin', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'node_modules/pkg/bin'), 0o755);
    const result = await warm();
    expect(result.failed).toEqual([]);
    expect(lstatSync(join(target, 'node_modules/pkg/bin')).mode & 0o777).toBe(0o755);
  },
  30_000,
);

test.skipIf(process.platform === 'win32')(
  'warm removes excluded copies from read-only directories and restores their modes (POSIX directory modes; skipped on win32)',
  async () => {
    write(root, 'node_modules/pkg/index.js', 'read-only package');
    write(root, 'node_modules/pkg/.DerivedData/large', 'excluded');
    chmodSync(join(root, 'node_modules/pkg'), 0o555);
    try {
      const result = await runWarm(target);
      expect(result.code).toBe(0);
      expect(readFileSync(join(target, 'node_modules/pkg/index.js'), 'utf-8')).toBe('read-only package');
      expect(lstatSync(join(target, 'node_modules/pkg')).mode & 0o777).toBe(0o555);
      expect(existsSync(join(target, 'node_modules/pkg/.DerivedData'))).toBe(false);
    } finally {
      chmodSync(join(root, 'node_modules/pkg'), 0o755);
      const pkg = join(target, 'node_modules/pkg');
      if (existsSync(pkg)) chmodSync(pkg, 0o755);
    }
  },
  30_000,
);

test('missing-only copy does not restore a deleted tracked file from ignored main state', async () => {
  write(target, '.env', 'tracked linked env');
  git(target, 'add', '-f', '.env');
  git(target, 'commit', '-qm', 'track linked env');
  rmSync(join(target, '.env'));
  write(root, '.env', 'ignored main env');
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: '.env', reason: 'tracked' }]);
  expect(existsSync(join(target, '.env'))).toBe(false);
}, 30_000);

test('warm copies project-owned .stim directories unless the main exclusion file skips them', async () => {
  write(root, '.gitignore', readFileSync(join(root, '.gitignore'), 'utf-8') + '.stim/\n');
  write(root, '.stim/project.json', 'root project data');
  write(root, 'apps/mobile/.stim/project.json', 'nested project data');
  write(root, '.worktreeexclude', '/.stim\n');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(existsSync(join(target, '.stim'))).toBe(false);
  expect(readFileSync(join(target, 'apps/mobile/.stim/project.json'), 'utf-8')).toBe('nested project data');
}, 30_000);

test('directly copied ignored files stay invisible to Git status and git add', async () => {
  write(root, '.env', 'source secret');
  const observations: { status: string; add: string; staged: string }[] = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    async runFileAsync(file, args, opts) {
      const result = real.runFile(file, args, opts);
      if (file === 'cp') {
        observations.push({
          status: git(target, 'status', '--porcelain', '--untracked-files=all'),
          add: git(target, 'add', '--dry-run', '--all'),
          staged: readFileSync(args[2], 'utf-8'),
        });
      }
      return result;
    },
  });
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(observations).toEqual([{ status: '', add: '', staged: 'source secret' }]);
  expect(readFileSync(join(target, '.env'), 'utf-8')).toBe('source secret');
}, 30_000);

test('warm preserves a deleted tracked file when main has ignored descendants at that path', async () => {
  write(root, 'local/README', 'main readme');
  git(root, 'add', '-f', 'local/README');
  git(root, 'commit', '-qm', 'track main local readme');
  write(root, 'local/data.cache', 'main cache');
  write(target, 'local', 'linked tracked file');
  git(target, 'add', '-f', 'local');
  git(target, 'commit', '-qm', 'track local file');
  rmSync(join(target, 'local'));
  const result = await warm();
  expect(result.copied).toEqual([]);
  expect(result.skipped).toEqual([{ file: 'local/data.cache', reason: 'tracked' }]);
  expect(result.failed).toEqual([]);
  expect(existsSync(join(target, 'local'))).toBe(false);
  expect(git(target, 'diff', '--name-status')).toBe('D\tlocal');
}, 30_000);

test('warm permits ignored siblings under a directory containing tracked files', async () => {
  write(root, 'local/README', 'main readme');
  git(root, 'add', '-f', 'local/README');
  git(root, 'commit', '-qm', 'track main local readme');
  write(root, 'local/data.cache', 'main cache');
  write(target, 'local/README', 'linked readme');
  git(target, 'add', '-f', 'local/README');
  git(target, 'commit', '-qm', 'track linked local readme');
  const result = await warm();
  expect(result.copied).toEqual(['local/data.cache']);
  expect(result.skipped).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(readFileSync(join(target, 'local/data.cache'), 'utf-8')).toBe('main cache');
  expect(readFileSync(join(target, 'local/README'), 'utf-8')).toBe('linked readme');
}, 30_000);

function bareLayout(): { bare: string; main: string; feature: string } {
  const bare = join(base, 'bare');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main', '.git');
  const main = join(bare, 'main');
  const feature = join(bare, 'feature');
  git(bare, 'worktree', 'add', '-q', main);
  git(main, 'config', 'user.name', 'test');
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'commit.gpgsign', 'false');
  write(main, '.gitignore', 'node_modules/\n.env*\n');
  write(main, 'package.json', '{"name":"bare-fixture"}\n');
  write(main, 'ios/Podfile.lock', 'branch pods\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'fixture');
  git(bare, 'worktree', 'add', '-qb', 'feature', feature, 'main');
  return { bare, main, feature };
}

test('warm in a bare-repository layout seeds from the worktree on the bare HEAD branch', async () => {
  const { bare, main, feature } = bareLayout();
  expect(await warmWorktreePaths(join(feature, 'ios'))).toEqual({
    root: main,
    target: feature,
    common: join(bare, '.git'),
  });
  write(main, '.env', 'main env');
  const result = await runWarm(feature);
  expect(result.code).toBe(0);
  expect(readFileSync(join(feature, '.env'), 'utf-8')).toBe('main env');
}, 30_000);

test('warm in a bare-repository layout rejects the worktree on the bare HEAD branch as the source checkout', async () => {
  const { main } = bareLayout();
  const result = await runWarm(main);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/linked worktree, not the source checkout/);
}, 30_000);

test('warm refuses a detached bare HEAD and prints the symbolic-ref command that repairs it', async () => {
  const { bare, main, feature } = bareLayout();
  git(bare, 'update-ref', '--no-deref', 'HEAD', git(main, 'rev-parse', 'HEAD'));
  await expect(warmWorktreePaths(feature)).rejects.toThrow(`git -C ${bare} symbolic-ref HEAD refs/heads/<branch>`);
}, 30_000);

test('warm refuses a bare HEAD branch that no worktree checks out and prints the worktree add command', async () => {
  const { bare, feature } = bareLayout();
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  await expect(warmWorktreePaths(feature)).rejects.toThrow(
    `git -C ${bare} worktree add ${join(bare, 'develop')} develop`,
  );
}, 30_000);

test('warm in a bare-repository layout still finds the source when a tag shares the HEAD branch name', async () => {
  const { bare, main, feature } = bareLayout();
  git(main, 'tag', 'main');
  expect(await warmWorktreePaths(feature)).toEqual({ root: main, target: feature, common: join(bare, '.git') });
}, 30_000);

test('warm refuses a deleted source worktree with the prune and re-add commands that restore it', async () => {
  const { bare, main, feature } = bareLayout();
  rmSync(main, { recursive: true, force: true });
  await expect(warmWorktreePaths(feature)).rejects.toThrow(
    `git -C ${bare} worktree prune\n  git -C ${bare} worktree add ${main} main`,
  );
}, 30_000);

const APP_PACKAGE = '{"name":"warm-app","dependencies":{"react-native":"0.80.0"}}\n';

test('warm registers the app it prepares and leaves it ready until the workspace is next used', async () => {
  write(root, 'package.json', APP_PACKAGE);
  git(root, 'commit', '-qam', 'app');
  git(target, 'merge', '-q', 'main');
  const result = await runWarm(target);
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(Object.keys(loadConfig()?.projects ?? {})).toEqual([target]);
  const state = readWorkspaceState(target);
  const record = readWarmRecord(state);
  assert(record?.phase === 'ready');
  expect(workspacePhase(false, state)).toEqual({ phase: 'ready', phaseSince: record.at });
  recordWorkspaceUse(target, new Date(Date.now() + 1000));
  expect(workspacePhase(false, readWorkspaceState(target))).toEqual({ phase: 'idle', phaseSince: null });
}, 30_000);

test('warm from a monorepo worktree root registers the app the source checkout registered', async () => {
  write(root, 'apps/mobile/package.json', APP_PACKAGE);
  write(root, 'apps/web/package.json', '{"name":"web"}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'apps');
  git(target, 'merge', '-q', 'main');
  upsertProject(join(root, 'apps/mobile'), {});
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'warm-shell');
  const result = await runWarm(target);
  vi.unstubAllEnvs();
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual([]);
  expect(readWorkspaceState(join(target, 'apps/mobile'))?.agentSession).toMatchObject({
    tool: 'claude-code',
    sessionId: 'warm-shell',
  });
  expect(Object.keys(loadConfig()?.projects ?? {}).toSorted()).toEqual([
    join(target, 'apps/mobile'),
    join(root, 'apps/mobile'),
  ]);
  expect(workspacePhase(false, readWorkspaceState(join(target, 'apps/mobile'))).phase).toBe('ready');
}, 30_000);

test('warm from a monorepo root that declares react-native still registers the registered app', async () => {
  write(root, 'package.json', APP_PACKAGE);
  write(root, 'apps/mobile/package.json', APP_PACKAGE);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'apps');
  git(target, 'merge', '-q', 'main');
  upsertProject(join(root, 'apps/mobile'), {});
  expect((await runWarm(target)).code).toBe(0);
  expect(Object.keys(loadConfig()?.projects ?? {})).toContain(join(target, 'apps/mobile'));
  expect(Object.keys(loadConfig()?.projects ?? {})).not.toContain(target);
}, 30_000);

test('status reads a warm as warming while it copies and as idle once it fails', async () => {
  write(root, 'package.json', APP_PACKAGE);
  git(root, 'commit', '-qam', 'app');
  git(target, 'merge', '-q', 'main');
  write(root, '.env', 'source env');
  const during: unknown[] = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    async runFileAsync(file, args, opts) {
      if (file === 'cp') {
        during.push(workspacePhase(false, readWorkspaceState(target)));
        throw new Error('disk full');
      }
      return real.runFileAsync(file, args, opts);
    },
  });
  const result = await runWarm(target);
  expect(result.code).toBe(1);
  expect(during[0]).toMatchObject({ phase: 'warming', warmStep: 'copy' });
  expect(readWarmRecord(readWorkspaceState(target))).toBeNull();
  expect(workspacePhase(false, readWorkspaceState(target)).phase).toBe('idle');
}, 30_000);

test('a warming record counts only while its claim holder lives, and ready lasts two hours', () => {
  const warming = (claimId: string) => ({
    warm: {
      phase: 'warming',
      step: 'refresh',
      startedAt: '2026-09-26T10:00:00.000Z',
      claim: { root: join(base, `${claimId}.lock`), claimId },
    },
  });
  plantClaim(join(base, 'live.lock'), 'shared', liveClaimOwner(), { claimId: 'live' });
  plantClaim(join(base, 'killed.lock'), 'shared', goneClaimOwner(), { claimId: 'killed' });
  expect(workspacePhase(false, warming('live'))).toEqual({
    phase: 'warming',
    phaseSince: '2026-09-26T10:00:00.000Z',
    warmStep: 'refresh',
  });
  expect(workspacePhase(false, warming('killed')).phase).toBe('idle');
  const ready = { warm: { phase: 'ready', at: '2026-09-26T10:00:00.000Z' } };
  const at = Date.parse('2026-09-26T10:00:00.000Z');
  expect(workspacePhase(false, ready, { now: at + READY_PHASE_MS - 1 }).phase).toBe('ready');
  expect(workspacePhase(false, ready, { now: at + READY_PHASE_MS }).phase).toBe('idle');
});

test.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
  'a destination permission error fails only that entry and preserves existing files',
  async () => {
    write(root, 'local/README', 'tracked file');
    write(root, '.gitignore', `${readFileSync(join(root, '.gitignore'), 'utf8')}z.cache\n`);
    git(root, 'add', '.gitignore');
    git(root, 'add', '-f', 'local/README');
    git(root, 'commit', '-qm', 'tracked local directory');
    git(target, 'merge', '--ff-only', 'main');
    write(root, 'local/a.cache', 'blocked cache');
    write(root, 'z.cache', 'healthy cache');
    chmodSync(join(target, 'local'), 0);
    try {
      const result = await warm();
      expect(result.failed).toEqual([{ file: 'local/a.cache', error: expect.stringContaining('EACCES') }]);
      expect(result.copied).toEqual(['z.cache']);
      expect(readFileSync(join(target, 'z.cache'), 'utf8')).toBe('healthy cache');
    } finally {
      chmodSync(join(target, 'local'), 0o755);
    }
    expect(readFileSync(join(target, 'local/README'), 'utf8')).toBe('tracked file');
  },
  30_000,
);
