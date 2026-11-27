import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStim } from '../api.ts';
import { runCli } from '../cli/define-op.ts';
import { addOp, removeOp, warmOp } from '../commands/worktree.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { processContext } from '../cli-operation.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { cloneIgnoredEntries } from '../workspace/worktree.ts';
import type { Op } from '../cli/define-op.ts';

const clones = process.platform === 'darwin';

let base: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

/** Every entry below `dir` outside `.git`, with a file's bytes and a link's target. */
function tree(dir: string, rel = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel)).toSorted()) {
    const path = rel ? `${rel}/${name}` : name;
    if (path === '.git') continue;
    const stat = lstatSync(join(dir, path));
    if (stat.isSymbolicLink()) entries[path] = `-> ${readlinkSync(join(dir, path))}`;
    else if (stat.isDirectory()) Object.assign(entries, { [path]: 'dir' }, tree(dir, path));
    else entries[path] = readFileSync(join(dir, path), 'utf-8');
  }
  return entries;
}

async function run(op: Op, cwd: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(`${String(value)}\n`));
  const stream = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const previous = process.cwd();
  process.exitCode = 0;
  try {
    process.chdir(cwd);
    await runCli(op, args, { version: '0.0.0' });
    return { stdout: stdout.join(''), stderr: stderr.join(''), code: process.exitCode || 0 };
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
    stream.mockRestore();
  }
}

/** `git worktree add` and `stim worktree warm`, the two commands `stim worktree add` stands for. */
async function plain(name: string, ...args: string[]): Promise<string> {
  const path = join(base, name);
  git(root, 'worktree', 'add', '-q', '-b', name, path, ...args);
  expect((await run(warmOp, path, [])).code).toBe(0);
  return path;
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-add-')));
  root = join(base, 'main');
  process.env.STIM_HOME = join(base, 'home');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitignore', 'node_modules/\n.env\nbuild/\ncache/\n.worktrees/\n');
  write(root, 'package.json', '{"name":"add-fixture"}\n');
  write(root, 'src/kept.txt', 'first\n');
  write(root, 'src/removed-later.txt', 'only in the first commit\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'first');
  write(root, 'src/kept.txt', 'second\n');
  write(root, 'src/added-later.txt', 'only in the second commit\n');
  write(root, 'cache/tracked-later.txt', 'tracked in the second commit\n');
  rmSync(join(root, 'src/removed-later.txt'));
  git(root, 'add', '-A');
  git(root, 'add', '-f', 'cache/tracked-later.txt');
  git(root, 'commit', '-qm', 'second');
  write(root, 'node_modules/pkg/index.js', 'package\n');
  write(root, '.env', 'SECRET=1\n');
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  process.exitCode = 0;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

test('a dirty source checkout gives a clean worktree at the target commit, the same as git worktree add then warm', async () => {
  write(root, '.worktreeexclude', 'build\n');
  write(root, 'build/output.bin', 'excluded from the carry\n');
  write(root, 'cache/ignored-only-at-first.txt', 'ignored at both commits\n');
  write(root, '.DS_Store', 'never carried\n');
  const longAgo = new Date('2020-01-01');
  utimesSync(join(root, 'package.json'), longAgo, longAgo);
  git(root, 'update-index', '--refresh');
  write(root, 'src/kept.txt', 'edited and not committed\n');
  write(root, 'package.json', '{"name":"ADD-FIXTURE"}\n');
  utimesSync(join(root, 'package.json'), longAgo, longAgo);
  write(root, 'untracked.txt', 'untracked and not ignored\n');
  write(root, 'staged.txt', 'staged and not committed\n');
  git(root, 'add', 'staged.txt');
  mkdirSync(join(root, 'untracked-repository'));
  git(join(root, 'untracked-repository'), 'init', '-q');
  rmSync(join(root, 'src/added-later.txt'));
  const dirty = git(root, 'status', '--porcelain');
  const first = git(root, 'rev-parse', 'HEAD~1');

  const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);
  const path = join(base, 'added');

  expect(added).toMatchObject({ code: 0, stdout: '' });
  expect(added.stderr).toContain(clones ? `created ${path} as a clone of ${root}` : 'with git worktree add, because');
  expect(git(path, 'status', '--porcelain')).toBe('');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(first);
  expect(git(path, 'branch', '--show-current')).toBe('added');
  expect(git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${path}\n`);
  expect(tree(path)).toEqual(tree(await plain('plain', 'HEAD~1')));
  expect(tree(path)).toMatchObject({ 'node_modules/pkg/index.js': 'package\n', '.env': 'SECRET=1\n' });
  expect(git(root, 'status', '--porcelain')).toBe(dirty);

  expect((await run(removeOp, root, [path])).code).toBe(0);
  expect(existsSync(path)).toBe(false);
}, 60_000);

test('a submodule path ends as git worktree add leaves it and the source checkout keeps its submodule', async () => {
  const library = join(base, 'library');
  mkdirSync(library);
  git(library, 'init', '-q', '-b', 'main');
  git(library, 'config', 'user.name', 'test');
  git(library, 'config', 'user.email', 'test@example.com');
  git(library, 'config', 'commit.gpgsign', 'false');
  write(library, 'lib.txt', 'library\n');
  git(library, 'add', '.');
  git(library, 'commit', '-qm', 'library');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');
  git(root, 'commit', '-qm', 'submodule');
  const head = git(join(root, 'vendor/library'), 'rev-parse', 'HEAD');

  const added = await run(addOp, root, ['-b', 'added', '../added']);
  const path = join(base, 'added');

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(clones ? 'as a clone of' : 'with git worktree add');
  expect(readdirSync(join(path, 'vendor/library'))).toEqual([]);
  expect(git(path, 'status', '--porcelain')).toBe('');
  expect(tree(path)).toEqual(tree(await plain('plain')));
  expect(readFileSync(join(root, 'vendor/library/lib.txt'), 'utf-8')).toBe('library\n');
  expect(git(join(root, 'vendor/library'), 'rev-parse', 'HEAD')).toBe(head);
  expect(git(join(root, 'vendor/library'), 'status', '--porcelain')).toBe('');
  expect(git(root, 'status', '--porcelain')).toBe('');

  expect((await run(removeOp, root, [path])).code).toBe(0);
  expect(existsSync(path)).toBe(false);

  expect((await run(addOp, root, ['-b', 'before', '../before', 'HEAD~1'])).code).toBe(0);
  expect(git(join(base, 'before'), 'status', '--porcelain')).toBe('');
  expect(tree(join(base, 'before'))).toEqual(tree(await plain('plain-before', 'HEAD~1')));

  execFileSync('git', ['-C', root, 'checkout', '-q', '--detach', 'HEAD~1'], { stdio: 'ignore' });
  expect(readFileSync(join(root, 'vendor/library/lib.txt'), 'utf-8')).toBe('library\n');
  expect((await run(addOp, root, ['-b', 'after', '../after', 'main'])).code).toBe(0);
  expect(readdirSync(join(base, 'after/vendor/library'))).toEqual([]);
  expect(git(join(base, 'after'), 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(root, 'vendor/library/lib.txt'), 'utf-8')).toBe('library\n');
}, 60_000);

test.skipIf(!clones)(
  'a clone that fails removes the half-made worktree and its branch, then git creates both (APFS clonefile; darwin only)',
  async () => {
    const real = getExecutor();
    const attempts: string[] = [];
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (!file.includes('stim-clonefile') || !args.includes(join(root, 'package.json')))
          return real.runFileAsync(file, args, opts);
        attempts.push(git(root, 'worktree', 'list', '--porcelain'));
        await real.runFileAsync(file, [join(root, 'package.json'), join(base, 'added', 'package.json')], opts);
        throw new Error('clonefile: Operation not supported');
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);
    const path = join(base, 'added');

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toContain('branch refs/heads/added');
    expect(added.code).toBe(0);
    expect(added.stderr).toContain(
      `created ${path} with git worktree add, because cloning failed (clonefile: Operation not supported)`,
    );
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD~1'));
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
    resetExecutor();
    expect(tree(path)).toEqual(tree(await plain('plain', 'HEAD~1')));
  },
  60_000,
);

test('a worktree added inside the source checkout carries no other worktree', async () => {
  const other = join(root, '.worktrees/other');
  git(root, 'worktree', 'add', '-q', '-b', 'other', other);
  write(other, 'in-progress.txt', 'work in another worktree\n');
  write(root, '.worktrees/notes.txt', 'beside the worktrees\n');

  const added = await run(addOp, root, ['-b', 'added', '.worktrees/added']);
  const path = join(root, '.worktrees/added');

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(clones ? 'as a clone of' : 'with git worktree add');
  expect(existsSync(join(path, '.worktrees'))).toBe(false);
  expect(tree(path)).toMatchObject({ 'node_modules/pkg/index.js': 'package\n', 'src/kept.txt': 'second\n' });
  expect(git(path, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(other, 'in-progress.txt'), 'utf-8')).toBe('work in another worktree\n');
  expect(git(other, 'branch', '--show-current')).toBe('other');
}, 60_000);

test.skipIf(!clones)(
  'a directory the warm leaves out is never cloned, at the top level or inside a tracked folder (APFS clonefile; darwin only)',
  async () => {
    write(root, '.worktreeexclude', 'build\n');
    write(root, 'build/large/output.bin', 'left out at the top level\n');
    write(root, 'src/.idea/workspace.xml', 'left out inside a tracked folder\n');
    write(root, 'src/node_modules/nested/index.js', 'carried inside a tracked folder\n');
    write(root, '.git/info/exclude', '.idea/\n');
    const real = getExecutor();
    const cloned: string[] = [];
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file.includes('stim-clonefile')) cloned.push(...args.filter((_: string, index: number) => index % 2 === 0));
        return real.runFileAsync(file, args, opts);
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added']);
    resetExecutor();

    expect(added.stderr).toContain('as a clone of');
    expect(cloned).toContain(join(root, 'node_modules'));
    expect(cloned).toContain(join(root, 'src/node_modules'));
    expect(cloned).toContain(join(root, 'src/kept.txt'));
    expect(cloned.filter((path) => /\/(build|\.idea|src)$/.test(path))).toEqual([]);
    expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));

    for (let index = 0; index < 300; index++) {
      write(root, `packages/p${index}/index.js`, 'tracked\n');
      write(root, `packages/p${index}/.idea/workspace.xml`, 'left out\n');
    }
    git(root, 'add', 'packages');
    git(root, 'commit', '-qm', 'packages');
    let calls = 0;
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file.includes('stim-clonefile')) calls++;
        return real.runFileAsync(file, args, opts);
      },
    });
    const many = await run(addOp, root, ['-b', 'many', '../many']);
    expect(many.stderr).toContain('as a clone of');
    expect(calls).toBeGreaterThan(1);
    expect(existsSync(join(base, 'many/packages/p299/index.js'))).toBe(true);
    expect(existsSync(join(base, 'many/packages/p299/.idea'))).toBe(false);
  },
  60_000,
);

test('an edit that kept its file size and modification time does not reach a worktree at the same commit', async () => {
  const longAgo = new Date('2020-01-01');
  utimesSync(join(root, 'src/kept.txt'), longAgo, longAgo);
  git(root, 'update-index', '--refresh');
  write(root, 'src/kept.txt', 'SECOND\n');
  utimesSync(join(root, 'src/kept.txt'), longAgo, longAgo);

  const added = await run(addOp, root, ['-b', 'added', '../added']);

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(clones ? 'as a clone of' : 'with git worktree add');
  expect(readFileSync(join(base, 'added/src/kept.txt'), 'utf-8')).toBe('second\n');
  expect(git(join(base, 'added'), 'status', '--porcelain')).toBe('');
}, 60_000);

/**
 * Gives every tracked file of the source checkout an old modification time and records it, so no index entry is
 * racy: git compares the content of a file modified in the second its index was written.
 */
function settle(): void {
  const longAgo = new Date('2020-01-01');
  for (const path of git(root, 'ls-files', '-z').split('\0').filter(Boolean))
    if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() === false)
      if (lstatSync(join(root, path)).mtimeMs !== longAgo.getTime()) lutimesSync(join(root, path), longAgo, longAgo);
  git(root, 'update-index', '--refresh');
}

/** The tracked files of the worktree `path` that are not clones of the source checkout's, which `settle` dated. */
function written(path: string): string[] {
  return git(path, 'ls-files', '-z')
    .split('\0')
    .filter(
      (file) =>
        file &&
        !lstatSync(join(path, file)).isDirectory() &&
        lstatSync(join(path, file)).mtimeMs !== lstatSync(join(root, file)).mtimeMs,
    );
}

/**
 * Fails unless every tracked path of the worktree `path` holds the bytes and mode of its commit, read without the
 * index, and the index already holds the stat data git records for those files.
 */
function expectExactCheckout(path: string): void {
  const wrong: string[] = [];
  for (const record of git(path, 'ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean)) {
    const [mode, , oid] = record.slice(0, record.indexOf('\t')).split(' ');
    const file = join(path, record.slice(record.indexOf('\t') + 1));
    const stat = lstatSync(file, { throwIfNoEntry: false });
    const hash = (...args: string[]) =>
      execFileSync('git', ['-C', path, 'hash-object', ...args], {
        input: stat?.isSymbolicLink() ? readlinkSync(file) : '',
        encoding: 'utf-8',
      }).trim();
    const exact =
      mode === '160000'
        ? stat?.isDirectory() && readdirSync(file).length === 0
        : mode === '120000'
          ? stat?.isSymbolicLink() && hash('--stdin') === oid
          : stat?.isFile() && hash('--no-filters', file) === oid && ((stat.mode & 0o100) !== 0) === (mode === '100755');
    if (!exact) wrong.push(file);
  }
  expect(wrong).toEqual([]);
  const before = git(path, 'ls-files', '--stage', '--debug');
  git(path, 'update-index', '--really-refresh');
  expect(git(path, 'ls-files', '--stage', '--debug')).toBe(before);
  expect(git(path, 'status', '--porcelain')).toBe('');
}

function commitVariety(): void {
  write(root, 'bin/run.sh', '#!/bin/sh\n');
  chmodSync(join(root, 'bin/run.sh'), 0o755);
  symlinkSync('src/kept.txt', join(root, 'link'));
  write(root, 'folder/inside.txt', 'inside a folder\n');
  write(root, 'folder/other.txt', 'beside it\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'variety');
}

const unchangedSources: [string, () => void][] = [
  ['an index of version 2', () => git(root, 'update-index', '--index-version', '2')],
  ['an index of version 4', () => git(root, 'update-index', '--index-version', '4')],
  [
    'feature.manyFiles',
    () => {
      git(root, 'config', 'feature.manyFiles', 'true');
      git(root, 'update-index', '--index-version', '4');
      git(root, 'status');
    },
  ],
  [
    'index.skipHash',
    () => {
      git(root, 'config', 'index.skipHash', 'true');
      git(root, 'update-index', '--force-write');
    },
  ],
  [
    'the untracked cache',
    () => {
      git(root, 'config', 'core.untrackedCache', 'true');
      write(root, 'untracked.txt', 'in the source only\n');
      git(root, 'update-index', '--untracked-cache');
      git(root, 'status');
    },
  ],
  [
    'a submodule entry',
    () => {
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`);
      mkdirSync(join(root, 'vendor/sub'), { recursive: true });
      git(root, 'commit', '-qm', 'gitlink');
    },
  ],
];

for (const [name, prepare] of unchangedSources)
  test.skipIf(!clones)(
    `a source checkout git sees as unchanged, with ${name}, is cloned without git reading a tracked file (APFS clone inodes; darwin only)`,
    async () => {
      commitVariety();
      prepare();
      settle();

      const same = await run(addOp, root, ['-b', 'same', '../same']);
      const older = await run(addOp, root, ['-b', 'older', '../older', 'HEAD~2']);

      expect(same.stderr).toContain('as a clone of');
      expect(older.stderr).toContain('as a clone of');
      expect(written(join(base, 'same'))).toEqual([]);
      expectExactCheckout(join(base, 'same'));
      expectExactCheckout(join(base, 'older'));
      expect(tree(join(base, 'older'))).toEqual(tree(await plain('plain', 'HEAD~2')));
    },
    60_000,
  );

const changedSources: [string, () => void][] = [
  [
    'edits, removals, mode changes and staged changes',
    () => {
      write(root, 'src/kept.txt', 'edited and not committed\n');
      rmSync(join(root, 'src/added-later.txt'));
      chmodSync(join(root, 'package.json'), 0o755);
      chmodSync(join(root, 'bin/run.sh'), 0o644);
      rmSync(join(root, 'link'));
      symlinkSync('package.json', join(root, 'link'));
      write(root, 'staged.txt', 'staged and not committed\n');
      write(root, 'cache/tracked-later.txt', 'staged edit\n');
      git(root, 'add', '-f', 'staged.txt', 'cache/tracked-later.txt');
      write(root, 'intended.txt', 'intent to add\n');
      git(root, 'add', '-N', 'intended.txt');
      rmSync(join(root, 'folder'), { recursive: true });
      write(root, 'folder', 'a file where a folder was\n');
      rmSync(join(root, 'bin/run.sh'));
      mkdirSync(join(root, 'bin/run.sh'));
      write(root, 'bin/run.sh/inside.txt', 'a folder where a file was\n');
    },
  ],
  [
    'an edit that kept its size and both of its times in whole seconds',
    () => {
      const before = lstatSync(join(root, 'src/kept.txt'));
      write(root, 'src/kept.txt', 'SECOND\n');
      utimesSync(join(root, 'src/kept.txt'), before.atime, before.mtime);
    },
  ],
  [
    'an index older than the files it lists',
    () => {
      write(root, 'src/kept.txt', 'edited and not committed\n');
      utimesSync(join(root, '.git/index'), new Date('2019-01-01'), new Date('2019-01-01'));
    },
  ],
  [
    'a merge conflict',
    () => {
      git(root, 'checkout', '-q', '-b', 'side', 'HEAD~1');
      write(root, 'src/kept.txt', 'side\n');
      git(root, 'commit', '-qam', 'side');
      git(root, 'checkout', '-q', 'main');
      write(root, 'src/kept.txt', 'main\n');
      git(root, 'commit', '-qam', 'main');
      expect(() => git(root, 'merge', 'side')).toThrow('Command failed');
      expect(git(root, 'ls-files', '--unmerged')).toContain('src/kept.txt');
    },
  ],
  [
    'a folder replaced by a relative link to its renamed self',
    () => {
      renameSync(join(root, 'src'), join(root, 'moved'));
      symlinkSync('moved', join(root, 'src'));
    },
  ],
  [
    'a folder replaced by an absolute link into the source checkout',
    () => {
      renameSync(join(root, 'src'), join(root, 'moved'));
      symlinkSync(join(root, 'moved'), join(root, 'src'));
    },
  ],
  [
    'an fsmonitor hook that reports no change',
    () => {
      write(base, 'fsmonitor.sh', "#!/bin/sh\nprintf 'token\\0'\n");
      chmodSync(join(base, 'fsmonitor.sh'), 0o755);
      git(root, 'config', 'core.fsmonitor', join(base, 'fsmonitor.sh'));
      git(root, 'config', 'core.fsmonitorHookVersion', '2');
      git(root, 'status');
      git(root, 'status');
      expect(git(root, 'ls-files', '-f', 'src/kept.txt')).toBe('h src/kept.txt');
      write(root, 'src/kept.txt', 'an edit the hook hides\n');
    },
  ],
];

for (const [name, prepare] of changedSources)
  test.skipIf(!clones)(
    `a source checkout with ${name} gives exactly the commit, at its own commit and at an older one (APFS clone inodes; darwin only)`,
    async () => {
      commitVariety();
      settle();
      prepare();
      const source = tree(root);

      const same = await run(addOp, root, ['-b', 'same', '../same']);
      const older = await run(addOp, root, ['-b', 'older', '../older', 'HEAD~2']);

      expect(same.stderr).toContain('as a clone of');
      expect(older.stderr).toContain('as a clone of');
      expect(tree(root)).toEqual(source);
      git(root, 'config', 'core.fsmonitor', 'false');
      expectExactCheckout(join(base, 'same'));
      expectExactCheckout(join(base, 'older'));
      expect(tree(join(base, 'same'))).toEqual(tree(await plain('plain-same')));
      expect(tree(join(base, 'older'))).toEqual(tree(await plain('plain-older', 'HEAD~2')));
    },
    60_000,
  );

test.skipIf(!clones)(
  'a folder swapped for a look-alike while the clone runs does not leave its files in the new worktree (APFS clonefile; darwin only)',
  async () => {
    settle();
    const real = getExecutor();
    const longAgo = new Date('2020-01-01');
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (!file.includes('stim-clonefile') || !args.includes(join(root, 'src')))
          return real.runFileAsync(file, args, opts);
        renameSync(join(root, 'src'), join(root, 'moved'));
        write(root, 'src/kept.txt', 'SECOND\n');
        write(root, 'src/added-later.txt', 'ONLY IN THE SECOND COMMIT\n');
        for (const name of ['kept.txt', 'added-later.txt']) utimesSync(join(root, 'src', name), longAgo, longAgo);
        try {
          return await real.runFileAsync(file, args, opts);
        } finally {
          rmSync(join(root, 'src'), { recursive: true });
          renameSync(join(root, 'moved'), join(root, 'src'));
        }
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added']);

    expect(added.stderr).toContain('as a clone of');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expectExactCheckout(join(base, 'added'));
  },
  60_000,
);

/** Checks `file` out again in the source checkout, so its bytes are what git writes under the conversion in force. */
function checkOutAgain(file: string): void {
  rmSync(join(root, file));
  git(root, 'checkout', '--', file);
}

const convertedSources: [string, () => void][] = [
  [
    'a file checked out under core.autocrlf=true before it was turned off',
    () => {
      git(root, 'config', 'core.autocrlf', 'true');
      checkOutAgain('src/kept.txt');
      expect(readFileSync(join(root, 'src/kept.txt'), 'utf-8')).toBe('second\r\n');
      settle();
      git(root, 'config', 'core.autocrlf', 'false');
    },
  ],
  [
    'CRLF files from a .gitattributes the source checkout has not committed',
    () => {
      write(root, '.gitattributes', '*.txt eol=crlf\n');
      checkOutAgain('src/kept.txt');
      expect(readFileSync(join(root, 'src/kept.txt'), 'utf-8')).toBe('second\r\n');
      settle();
    },
  ],
  [
    'an LF file where the commit asks for CRLF',
    () => {
      write(root, '.gitattributes', '*.txt text eol=crlf\n');
      git(root, 'add', '.gitattributes');
      git(root, 'commit', '-qm', 'attributes');
    },
  ],
  [
    'an ident attribute',
    () => {
      write(root, '.gitattributes', '*.txt ident\n');
      write(root, 'src/ident.txt', '$Id$\n');
      git(root, 'add', '.gitattributes', 'src/ident.txt');
      git(root, 'commit', '-qm', 'ident');
      checkOutAgain('src/ident.txt');
      expect(readFileSync(join(root, 'src/ident.txt'), 'utf-8')).toMatch(/^\$Id: [0-9a-f]{40} \$\n$/);
    },
  ],
  [
    'a smudge filter whose output the source checkout no longer holds',
    () => {
      git(root, 'config', 'filter.upper.clean', 'tr A-Z a-z');
      git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
      write(root, '.gitattributes', 'src/kept.txt filter=upper\n');
      git(root, 'add', '.gitattributes');
      git(root, 'commit', '-qm', 'filter');
    },
  ],
  [
    'a working-tree-encoding',
    () => {
      write(root, '.gitattributes', 'src/kept.txt working-tree-encoding=UTF-16LE\n');
      writeFileSync(join(root, 'src/kept.txt'), Buffer.from('second\n', 'utf16le'));
      git(root, 'add', '.gitattributes', 'src/kept.txt');
      git(root, 'commit', '-qm', 'encoding');
    },
  ],
];

for (const [name, prepare] of convertedSources)
  test.skipIf(!clones)(
    `a source checkout with ${name} gives the bytes git worktree add writes (APFS clone inodes; darwin only)`,
    async () => {
      settle();
      prepare();
      expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');

      const added = await run(addOp, root, ['-b', 'added', '../added']);

      expect(added.stderr).toContain('as a clone of');
      expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));
      expect(git(join(base, 'added'), 'status', '--porcelain')).toBe('');
      expect(written(join(base, 'added'))).not.toContain('package.json');
    },
    60_000,
  );

for (const setting of ['core.autocrlf=true', 'core.autocrlf=input', 'core.eol=crlf'])
  test.skipIf(!clones)(
    `a repository with ${setting} takes the plain path and gives the same worktree (APFS clonefile; darwin only)`,
    async () => {
      git(root, 'config', ...setting.split('='));

      const added = await run(addOp, root, ['-b', 'added', '../added']);

      expect(added.stderr).toContain('with git worktree add, because cloning failed (core.autocrlf or core.eol');
      expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));
    },
    60_000,
  );

test.skipIf(!clones)(
  'a SHA-256 repository takes the plain path (APFS clonefile; darwin only)',
  async () => {
    const other = join(base, 'sha256');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main', '--object-format=sha256');
    git(other, 'config', 'user.name', 'test');
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'commit.gpgsign', 'false');
    git(other, 'config', 'index.skipHash', 'true');
    write(other, 'src/kept.txt', 'tracked\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'first');
    write(other, 'src/kept.txt', 'edited and not committed\n');

    const added = await run(addOp, other, ['-b', 'added', '../sha256-added']);

    expect(added.stderr).toContain('with git worktree add, because cloning failed (a sha256 index is not copied)');
    expect(readFileSync(join(base, 'sha256-added/src/kept.txt'), 'utf-8')).toBe('tracked\n');
  },
  60_000,
);

test.skipIf(!clones)(
  'a file marked assume-unchanged after the checks takes the plain path (APFS clonefile; darwin only)',
  async () => {
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync(file, args, opts) {
        if (file === 'git' && args.includes('--no-checkout')) {
          git(root, 'update-index', '--assume-unchanged', 'src/kept.txt');
          write(root, 'src/kept.txt', 'hidden edit\n');
        }
        return real.runFileAsync(file, args, opts);
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added']);

    expect(added.code).toBe(0);
    expect(added.stderr).toContain('with git worktree add, because cloning failed');
    expect(readFileSync(join(base, 'added/src/kept.txt'), 'utf-8')).toBe('second\n');
    expect(git(join(base, 'added'), 'ls-files', '-v', 'src/kept.txt')).toBe('H src/kept.txt');
  },
  60_000,
);

test('a source checkout with a split index takes the plain path and gives the same worktree', async () => {
  git(root, 'update-index', '--split-index');

  const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(
    clones ? 'with git worktree add, because the source checkout uses a split index' : 'with git worktree add',
  );
  expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain', 'HEAD~1')));
}, 60_000);

test('an edit git hides in the source checkout does not reach the new worktree', async () => {
  git(root, 'update-index', '--assume-unchanged', 'src/kept.txt');
  write(root, 'src/kept.txt', 'hidden edit\n');

  const added = await run(addOp, root, ['-b', 'added', '../added']);

  expect(added.code).toBe(0);
  expect(added.stderr).toContain('with git worktree add, because');
  expect(readFileSync(join(base, 'added/src/kept.txt'), 'utf-8')).toBe('second\n');
  expect(git(join(base, 'added'), 'ls-files', '-v', 'src/kept.txt')).toBe('H src/kept.txt');
}, 60_000);

test.skipIf(process.platform === 'win32')(
  'post-checkout runs once in the new worktree with the arguments git worktree add gives it (POSIX hook script; skipped on win32)',
  async () => {
    const log = join(base, 'hook.log');
    write(root, '.git/hooks/post-checkout', `#!/bin/sh\necho "$PWD $*" >> '${log}'\necho printed by the hook\n`);
    chmodSync(join(root, '.git/hooks/post-checkout'), 0o755);

    const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);
    expect(added).toMatchObject({ code: 0, stdout: '' });
    expect(added.stderr).toContain('printed by the hook\n');

    const first = git(root, 'rev-parse', 'HEAD~1');
    expect(readFileSync(log, 'utf-8')).toBe(`${join(base, 'added')} ${'0'.repeat(first.length)} ${first} 1\n`);

    write(root, '.worktreeexclude', 'cache\n');
    write(
      root,
      '.git/hooks/post-checkout',
      `#!/bin/sh\necho hook > .env\nmkdir -p cache && echo hook > cache/made-by-hook\necho again >> '${log}'\nexit 1\n`,
    );
    const failing = await run(addOp, root, ['-b', 'failing', '../failing']);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain('post-checkout failed');
    expect(readFileSync(log, 'utf-8').match(/again/g)).toHaveLength(1);
    expect(git(join(base, 'failing'), 'status', '--porcelain')).toBe('');
    expect(tree(join(base, 'failing'))).toMatchObject({
      '.env': 'hook\n',
      'cache/made-by-hook': 'hook\n',
      'node_modules/pkg/index.js': 'package\n',
    });

    git(root, 'update-index', '--assume-unchanged', 'src/kept.txt');
    const plainPath = await run(addOp, root, ['-b', 'plain-path', '../plain-path']);
    expect(plainPath.code).toBe(1);
    expect(plainPath.stderr).toContain('with git worktree add, because');
    expect(plainPath.stderr).toContain('post-checkout failed');
    expect(readFileSync(log, 'utf-8').match(/again/g)).toHaveLength(2);
    expect(tree(join(base, 'plain-path'))).toEqual(tree(join(base, 'failing')));
  },
  60_000,
);

test.skipIf(!clones)(
  'a cloned worktree keeps the cloned files and its index describes them when the command returns (APFS clone inodes; darwin only)',
  async () => {
    settle();
    expect((await run(addOp, root, ['-b', 'added', '../added'])).code).toBe(0);

    const path = join(base, 'added');
    expect(lstatSync(join(path, 'src/kept.txt')).ino).not.toBe(lstatSync(join(root, 'src/kept.txt')).ino);
    expect(lstatSync(join(path, 'src/kept.txt')).mtimeMs).toBe(lstatSync(join(root, 'src/kept.txt')).mtimeMs);
    expect(git(path, 'ls-files', '--debug', 'src/kept.txt')).toContain(
      `ino: ${lstatSync(join(path, 'src/kept.txt')).ino}`,
    );
    write(path, 'new.txt', 'first edit\n');
    git(path, 'add', 'new.txt');
    expect(git(path, 'status', '--porcelain')).toBe('A  new.txt');
  },
  60_000,
);

test('a warm that refuses leaves the new worktree with no ignored files, as git worktree add alone does', async () => {
  write(root, '.stim.json', '{"worktree":{"exclude":"not a list"}}');

  const added = await run(addOp, root, ['-b', 'added', '../added']);

  expect(added.code).toBe(1);
  expect(git(join(base, 'added'), 'status', '--porcelain', '--ignored')).toBe('');
  expect(readFileSync(join(base, 'added/src/kept.txt'), 'utf-8')).toBe('second\n');
}, 60_000);

test('an entry the warm checks before carrying is copied again under that check', async () => {
  const path = join(base, 'added');
  git(root, 'worktree', 'add', '-q', '-b', 'added', path);
  write(root, 'build/output.bin', 'what the check approved\n');
  write(path, 'build/output.bin', 'an earlier clone\n');
  write(path, 'node_modules/pkg/index.js', 'an earlier clone, not checked\n');

  const result = await cloneIgnoredEntries({
    root,
    target: path,
    patterns: [],
    operation: processContext(path),
    precloned: true,
    withhold: (rel) => (rel === 'build' ? Promise.resolve(null) : null),
  });

  expect(result.copied.toSorted()).toEqual(['.env', 'build', 'node_modules']);
  expect(readFileSync(join(path, 'build/output.bin'), 'utf-8')).toBe('what the check approved\n');
  expect(readFileSync(join(path, 'node_modules/pkg/index.js'), 'utf-8')).toBe('an earlier clone, not checked\n');
}, 60_000);

test.skipIf(!clones)(
  'the source checkout is claimed from before git registers the worktree until the warm has checked what it carried, and free for the hook (APFS clonefile; darwin only)',
  async () => {
    const real = getExecutor();
    const readers: [string, number][] = [];
    let refreshCouldStart = false;
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        const step = ['--no-checkout', 'reset', '--untracked-files=normal', 'hook'].find((arg) => args.includes(arg));
        if (file === 'git' && step) readers.push([step, readClaimSet(warmClaimPath(root)).live.length]);
        if (file === 'git' && step === 'hook') {
          const refresh = tryAcquireClaim({ root: warmClaimPath(root), mode: 'exclusive', label: 'worktree warm' });
          refreshCouldStart = Boolean(refresh.acquired);
          releaseClaim(refresh.acquired ?? refresh.pending);
        }
        return real.runFileAsync(file, args, opts);
      },
    });

    expect((await run(addOp, root, ['-b', 'added', '../added'])).code).toBe(0);

    expect(readers).toEqual([
      ['--no-checkout', 1],
      ['reset', 1],
      ['--untracked-files=normal', 1],
      ['hook', 0],
    ]);
    expect(refreshCouldStart).toBe(true);
  },
  60_000,
);

test.skipIf(!clones)(
  'an operation that waits for the source claim creates nothing if cancelled, and never deletes a branch made meanwhile (APFS clonefile; darwin only)',
  async () => {
    const refreshing = tryAcquireClaim({ root: warmClaimPath(root), mode: 'exclusive', label: 'worktree warm' });
    onTestFinished(() => void releaseClaim(refreshing.acquired));
    expect(refreshing.acquired).toBeTruthy();
    const stim = createStim({ projectRoot: root, env: { ...process.env } });

    await expect(
      stim.addWorktree({ path: '../added', branch: 'added', signal: AbortSignal.timeout(1500) }),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });

    const real = getExecutor();
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file.includes('stim-clonefile')) throw new Error('clonefile: Operation not supported');
        return real.runFileAsync(file, args, opts);
      },
    });
    const waiting = run(addOp, root, ['../made-while-waiting']);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    git(root, 'branch', 'made-while-waiting', 'HEAD~1');
    releaseClaim(refreshing.acquired);
    expect((await waiting).code).toBe(0);
    expect(git(root, 'rev-parse', 'made-while-waiting')).toBe(git(root, 'rev-parse', 'HEAD~1'));
    git(root, 'worktree', 'remove', '--force', join(base, 'made-while-waiting'));

    expect(existsSync(join(base, 'added'))).toBe(false);
    expect(git(root, 'branch', '--list', 'added')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  },
  60_000,
);

test('git refusing the worktree fails the command without a second attempt', async () => {
  git(root, 'branch', 'taken');

  const added = await run(addOp, root, ['-b', 'taken', '../added']);

  expect(added.code).toBe(1);
  expect(added.stderr).toContain("a branch named 'taken' already exists");
  expect(existsSync(join(base, 'added'))).toBe(false);
  expect(git(root, 'rev-parse', 'taken')).toBe(git(root, 'rev-parse', 'HEAD'));
}, 60_000);

test.skipIf(!clones)(
  'an operation cancelled during the clone leaves no worktree and no branch, and one cancelled during the carry leaves no ignored file (APFS clonefile; darwin only)',
  async () => {
    const real = getExecutor();
    const cancelAt = async (during: (file: string, args: string[]) => boolean, path: string) => {
      const controller = new AbortController();
      setExecutor({
        ...real,
        async runFileAsync(file, args, opts) {
          const output = await real.runFileAsync(file, args, opts);
          if (during(file, args)) controller.abort();
          return output;
        },
      });
      const stim = createStim({ projectRoot: root, env: { ...process.env } });
      await expect(stim.addWorktree({ path, branch: path.slice(3), signal: controller.signal })).rejects.toMatchObject({
        code: 'STIM_CANCELLED',
      });
      resetExecutor();
    };

    await cancelAt((file) => file.includes('stim-clonefile'), '../cloning');
    expect(existsSync(join(base, 'cloning'))).toBe(false);
    expect(git(root, 'branch', '--list', 'cloning')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);

    await cancelAt((file, args) => file === 'git' && args.includes('--untracked-files=normal'), '../carrying');
    expect(git(join(base, 'carrying'), 'status', '--porcelain', '--ignored')).toBe('');
    expect(git(join(base, 'carrying'), 'branch', '--show-current')).toBe('carrying');
  },
  60_000,
);

test('addWorktree creates the warmed worktree and returns its path', async () => {
  const stim = createStim({ projectRoot: root, env: { ...process.env } });

  const result = await stim.addWorktree({ path: '../added', branch: 'added', commitish: 'HEAD~1' });

  expect(result).toEqual({ exitCode: 0, path: join(base, 'added') });
  expect(git(result.path, 'status', '--porcelain')).toBe('');
  expect(git(result.path, 'branch', '--show-current')).toBe('added');
  expect(readFileSync(join(result.path, 'node_modules/pkg/index.js'), 'utf-8')).toBe('package\n');
  await expect(stim.addWorktree({ path: '' })).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
}, 60_000);
