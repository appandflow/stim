import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
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
import { readClaimSet } from '../ownership-claim.ts';
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
  write(root, 'src/kept.txt', 'edited and not committed\n');
  write(root, 'untracked.txt', 'untracked and not ignored\n');
  write(root, 'staged.txt', 'staged and not committed\n');
  git(root, 'add', 'staged.txt');
  mkdirSync(join(root, 'untracked-repository'));
  git(join(root, 'untracked-repository'), 'init', '-q');
  rmSync(join(root, 'package.json'));
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
    write(root, '.git/hooks/post-checkout', `#!/bin/sh\necho "$PWD $*" >> '${log}'\n`);
    chmodSync(join(root, '.git/hooks/post-checkout'), 0o755);

    expect((await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1'])).code).toBe(0);

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
  'the index of a cloned worktree describes its own files when the command returns (APFS clone inodes; darwin only)',
  async () => {
    expect((await run(addOp, root, ['-b', 'added', '../added'])).code).toBe(0);

    const path = join(base, 'added');
    expect(lstatSync(join(path, 'src/kept.txt')).ino).not.toBe(lstatSync(join(root, 'src/kept.txt')).ino);
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
  'the source checkout stays claimed from the clone until the warm has checked what it carried (APFS clonefile; darwin only)',
  async () => {
    const real = getExecutor();
    const readers: number[] = [];
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file === 'git' && (args.includes('update-index') || args.includes('--untracked-files=normal')))
          readers.push(readClaimSet(warmClaimPath(root)).live.length);
        return real.runFileAsync(file, args, opts);
      },
    });

    expect((await run(addOp, root, ['-b', 'added', '../added'])).code).toBe(0);

    expect(readers).toEqual([1, 1]);
    expect(readClaimSet(warmClaimPath(root)).live).toEqual([]);
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
