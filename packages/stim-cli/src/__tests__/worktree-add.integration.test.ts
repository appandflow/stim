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
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { binaryPath } from 'cow-clone';
import { createStim } from '../api.ts';
import { runCli } from '../cli/define-op.ts';
import { addOp, removeOp, warmOp } from '../commands/worktree.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { processContext } from '../cli-operation.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { cloneIgnoredEntries } from '../workspace/worktree.ts';
import type { Op } from '../cli/define-op.ts';

// APFS clones; a Linux lane sets TEST_CLONE_VOLUME when its temporary directory is on btrfs or XFS. On Windows the
// command never clones a checkout.
const clones = process.platform === 'darwin' || (process.platform !== 'win32' && process.env.TEST_CLONE_VOLUME === '1');
const plainReason =
  process.platform === 'win32'
    ? 'on Windows git would write through the junctions a clone keeps'
    : 'the file system cannot clone (unsupported, ';

/** The pairs of a cow-clone call that clones into `dir`, empty for any other call. */
function clonesInto(dir: string, file: string, opts: { input?: string }): [string, string][] {
  if (file !== binaryPath()) return [];
  const paths = (opts.input ?? '').split('\0');
  const pairs: [string, string][] = [];
  for (let at = 0; at + 1 < paths.length; at += 2) pairs.push([paths[at] ?? '', paths[at + 1] ?? '']);
  return pairs.some(([, to]) => to.startsWith(`${dir}${sep}`)) ? pairs : [];
}

/** What the executor rejects with when cow-clone exits 1 with `pairs` not cloned. */
function notCloned(pairs: [string, string][]): Error {
  const results = pairs.map(([, path]) => ({
    cloned: false,
    reason: 'failed',
    code: 'EIO',
    message: 'Input/output error',
    path,
  }));
  return Object.assign(new Error('Command failed'), { status: 1, stdout: JSON.stringify({ results }) });
}

let base: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

/** The extended attribute names of every entry below `dir`, by path; xattr(1) prints `path: name` lines. */
function extendedAttributes(dir: string): Map<string, string[]> {
  const names = new Map<string, string[]>();
  if (process.platform !== 'darwin') return names;
  for (const line of execFileSync('/usr/bin/xattr', ['-r', '-s', dir], { encoding: 'utf-8' }).split('\n')) {
    const at = line.lastIndexOf(': ');
    if (at > 0) names.set(line.slice(0, at), [...(names.get(line.slice(0, at)) ?? []), line.slice(at + 2)].toSorted());
  }
  return names;
}

/** The text of the files `names` of `dir`. */
function texts(dir: string, ...names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), 'utf-8')]));
}

/**
 * Every entry below `dir` outside `.git`, under the name it has on disk, with its permission bits, its extended
 * attributes and a file's bytes or a link's target.
 */
function tree(dir: string, rel = '', attributes = extendedAttributes(dir)): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel)).toSorted()) {
    const path = rel ? `${rel}/${name}` : name;
    if (path === '.git') continue;
    const stat = lstatSync(join(dir, path));
    const meta = `${(stat.mode & 0o7777).toString(8)} [${attributes.get(join(dir, path)) ?? ''}]`;
    if (stat.isSymbolicLink()) entries[path] = `${meta} -> ${readlinkSync(join(dir, path))}`;
    else if (stat.isDirectory()) Object.assign(entries, { [path]: `dir ${meta}` }, tree(dir, path, attributes));
    else entries[path] = `${meta} ${readFileSync(join(dir, path), 'latin1')}`;
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
  vi.unstubAllEnvs();
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
  expect(readdirSync(base).filter((name) => name.startsWith('.stim-clone-'))).toEqual([]);
  expect(added.stderr).toContain(
    clones ? `created ${path} as a clone of ${root}` : `created ${path} with git worktree add, because ${plainReason}`,
  );
  expect(git(path, 'status', '--porcelain')).toBe('');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(first);
  expect(git(path, 'branch', '--show-current')).toBe('added');
  expect(git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${path.replaceAll('\\', '/')}\n`);
  expect(tree(path)).toEqual(tree(await plain('plain', 'HEAD~1')));
  expect(texts(path, 'node_modules/pkg/index.js', '.env')).toEqual({
    'node_modules/pkg/index.js': 'package\n',
    '.env': 'SECRET=1\n',
  });
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
  git(
    root,
    '-c',
    'protocol.file.allow=always',
    '-c',
    'core.autocrlf=false',
    'submodule',
    'add',
    '-q',
    library,
    'vendor/library',
  );
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
}, 180_000);

test.skipIf(!clones)(
  'a clone that fails removes the half-made worktree and its branch, then git creates both (needs a volume that clones)',
  async () => {
    // A pnpm link: on Windows a junction, which the clone keeps pointing into the source checkout.
    symlinkSync(join(root, 'node_modules/pkg'), join(root, 'node_modules/linked'), 'junction');
    const real = getExecutor();
    const attempts: string[] = [];
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        const pairs = clonesInto(join(base, 'added'), file, opts);
        if (!pairs.length || attempts.length) return real.runFileAsync(file, args, opts);
        attempts.push(git(root, 'worktree', 'list', '--porcelain'));
        const partial = ['package.json', 'node_modules']
          .map((name) => `${join(root, name)}\0${join(base, 'added', name)}\0`)
          .join('');
        await real.runFileAsync(file, args, { ...opts, input: partial });
        throw notCloned(pairs);
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);
    const path = join(base, 'added');

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toContain('branch refs/heads/added');
    expect(added.code).toBe(0);
    expect(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf-8')).toBe('package\n');
    expect(added.stderr).toContain(
      `created ${path} with git worktree add, because cloning failed (Input/output error: `,
    );
    expect(added.stderr).toContain(' (failed, EIO))');
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD~1'));
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
    resetExecutor();
    // On Windows the warm points the link into each worktree, so the two targets differ.
    for (const dir of [root, path]) rmSync(join(dir, 'node_modules/linked'));
    expect(tree(path)).toEqual(tree(await plain('plain', 'HEAD~1')));
  },
  60_000,
);

test.each([
  ['carries no other worktree', true],
  ['does not carry the folder that holds it when no worktree was there before', false],
])(
  'a worktree added inside the source checkout %s',
  async (_, another) => {
    const other = join(root, '.worktrees/other');
    if (another) {
      git(root, 'worktree', 'add', '-q', '-b', 'other', other);
      write(other, 'in-progress.txt', 'work in another worktree\n');
    }
    write(root, '.worktrees/notes.txt', 'beside the worktrees\n');

    const added = await run(addOp, root, ['-b', 'added', '.worktrees/added']);
    const path = join(root, '.worktrees/added');

    expect(added.code).toBe(0);
    expect(added.stderr).toContain(clones ? 'as a clone of' : 'with git worktree add');
    expect(existsSync(join(path, '.worktrees'))).toBe(false);
    expect(texts(path, 'node_modules/pkg/index.js', 'src/kept.txt')).toEqual({
      'node_modules/pkg/index.js': 'package\n',
      'src/kept.txt': 'second\n',
    });
    expect(git(path, 'status', '--porcelain')).toBe('');
    if (!another) return;
    expect(readFileSync(join(other, 'in-progress.txt'), 'utf-8')).toBe('work in another worktree\n');
    expect(git(other, 'branch', '--show-current')).toBe('other');
  },
  60_000,
);

test.skipIf(!clones)(
  'a directory the warm leaves out is never cloned, at the top level or inside a tracked folder (needs a volume that clones)',
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
        cloned.push(...clonesInto(join(base, 'added'), file, opts).map(([from]) => from));
        return real.runFileAsync(file, args, opts);
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added']);
    resetExecutor();

    expect(added.stderr).toContain('as a clone of');
    expect(cloned).toContain(join(root, 'node_modules'));
    expect(cloned).toContain(join(root, 'src/node_modules'));
    expect(cloned).toContain(join(root, 'src/kept.txt'));
    expect(cloned.filter((path) => /[\\/](build|\.idea|src)$/.test(path))).toEqual([]);
    expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));

    for (let index = 0; index < 300; index++) {
      write(root, `packages/p${index}/index.js`, 'tracked\n');
      write(root, `packages/p${index}/.idea/workspace.xml`, 'left out\n');
    }
    git(root, 'add', 'packages');
    git(root, 'commit', '-qm', 'packages');
    resetExecutor();
    const many = await run(addOp, root, ['-b', 'many', '../many']);
    expect(many.stderr).toContain('as a clone of');
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

/** Checks `file` out again in the source checkout, so its bytes are what git writes under the conversion in force. */
function checkOutAgain(file: string): void {
  rmSync(join(root, file));
  git(root, 'checkout', '--', file);
}

function commitAttributes(attributes: string, ...files: string[]): void {
  write(root, '.gitattributes', attributes);
  git(root, 'add', '.gitattributes', ...files);
  git(root, 'commit', '-qm', 'attributes');
}

const cloned = 'as a clone of';
const checkedOut = 'with git worktree add, because';

/** A source checkout git reports clean, or dirty only as named, whose files are not what a checkout writes. */
const unlikeACheckout: [name: string, path: string, commit: string, prepare: () => void][] = [
  [
    'an untracked .gitattributes that asks for CRLF, at an older commit',
    cloned,
    'HEAD~1',
    () => write(root, '.gitattributes', '*.txt eol=crlf\n'),
  ],
  ['an LF file where the commit asks for CRLF', cloned, 'HEAD', () => commitAttributes('*.txt text eol=crlf\n')],
  [
    'a CRLF file left from core.autocrlf=true',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'core.autocrlf', 'true');
      checkOutAgain('src/kept.txt');
      expect(readFileSync(join(root, 'src/kept.txt'), 'utf-8')).toBe('second\r\n');
      git(root, 'update-index', '--refresh');
      git(root, 'config', 'core.autocrlf', 'false');
    },
  ],
  [
    'a CRLF file git cleans to its LF blob under core.autocrlf=input',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'core.autocrlf', 'input');
      write(root, 'src/kept.txt', 'second\r\n');
      git(root, 'add', 'src/kept.txt');
      expect(git(root, 'status', '--porcelain')).toBe('');
    },
  ],
  [
    'an ident attribute and an identifier from another blob',
    cloned,
    'HEAD',
    () => {
      write(root, 'src/ident.txt', '$Id$\n');
      commitAttributes('*.txt ident\n', 'src/ident.txt');
      write(root, 'src/ident.txt', `$Id: ${'0'.repeat(40)} $\n`);
    },
  ],
  [
    'a smudge filter whose output the source checkout does not hold',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'filter.upper.clean', 'tr A-Z a-z');
      git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
      commitAttributes('src/kept.txt filter=upper\n');
    },
  ],
  [
    'the output of a filter the commit no longer names',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'filter.upper.clean', 'tr A-Z a-z');
      git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
      commitAttributes('src/kept.txt filter=upper\n');
      checkOutAgain('src/kept.txt');
      git(root, 'rm', '-q', '--cached', '.gitattributes');
      git(root, 'commit', '-qm', 'no filter');
    },
  ],
  [
    'the output of a filter only an untracked .gitattributes names',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'filter.upper.clean', 'tr A-Z a-z');
      git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
      write(root, '.gitattributes', 'src/kept.txt filter=upper\n');
      checkOutAgain('src/kept.txt');
      expect(readFileSync(join(root, 'src/kept.txt'), 'utf-8')).toBe('SECOND\n');
      expect(git(root, 'status', '--porcelain')).toBe('?? .gitattributes');
    },
  ],
  [
    'a working-tree-encoding',
    cloned,
    'HEAD',
    () => {
      writeFileSync(join(root, 'src/kept.txt'), Buffer.from('second\n', 'utf16le'));
      commitAttributes('src/kept.txt working-tree-encoding=UTF-16LE\n', 'src/kept.txt');
    },
  ],
  [
    'core.checkStat=minimal and an edit that kept its size and modification time',
    cloned,
    'HEAD',
    () => {
      git(root, 'config', 'core.checkStat', 'minimal');
      const longAgo = new Date('2020-01-01');
      utimesSync(join(root, 'src/kept.txt'), longAgo, longAgo);
      git(root, 'update-index', '--refresh');
      write(root, 'src/kept.txt', 'SECOND\n');
      utimesSync(join(root, 'src/kept.txt'), longAgo, longAgo);
      expect(git(root, 'status', '--porcelain')).toBe('');
    },
  ],
  [
    'an fsmonitor hook that reports no change after an edit',
    cloned,
    'HEAD',
    () => {
      write(base, 'fsmonitor.sh', "#!/bin/sh\nprintf 'token\\0'\n");
      chmodSync(join(base, 'fsmonitor.sh'), 0o755);
      git(root, 'config', 'core.fsmonitor', join(base, 'fsmonitor.sh'));
      git(root, 'config', 'core.fsmonitorHookVersion', '2');
      git(root, 'status');
      git(root, 'status');
      write(root, 'src/kept.txt', 'an edit the hook hides\n');
      expect(git(root, 'status', '--porcelain')).toBe('');
    },
  ],
  [
    'a link created under another umask',
    cloned,
    'HEAD',
    () => {
      const umask = process.umask(0o077);
      symlinkSync('kept.txt', join(root, 'src/link'));
      process.umask(umask);
      git(root, 'add', 'src/link');
      git(root, 'commit', '-qm', 'link');
    },
  ],
  [
    'a file and a folder with other permission bits',
    cloned,
    'HEAD',
    () => {
      chmodSync(join(root, 'src/kept.txt'), 0o600);
      chmodSync(join(root, 'src'), 0o700);
      chmodSync(join(root, 'package.json'), 0o664);
    },
  ],
  [
    'a file whose name is spelled in another case on disk',
    cloned,
    'HEAD',
    () => {
      renameSync(join(root, 'src/kept.txt'), join(root, 'src/moved.txt'));
      renameSync(join(root, 'src/moved.txt'), join(root, 'src/KEPT.txt'));
    },
  ],
  [
    'a file whose name is decomposed on disk',
    cloned,
    'HEAD',
    () => {
      write(root, 'src/café.txt', 'precomposed in the commit\n');
      git(root, 'add', 'src');
      git(root, 'commit', '-qm', 'accent');
      renameSync(join(root, 'src/café.txt'), join(root, 'src/moved.txt'));
      renameSync(join(root, 'src/moved.txt'), join(root, 'src/café.txt'));
    },
  ],
  [
    'a folder whose name is spelled in another case on disk',
    checkedOut,
    'HEAD',
    () => {
      renameSync(join(root, 'src'), join(root, 'moved'));
      renameSync(join(root, 'moved'), join(root, 'SRC'));
    },
  ],
  [
    'two tracked paths that differ only in case',
    checkedOut,
    'HEAD',
    () => {
      const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'other case\n' });
      git(root, 'update-index', '--add', '--cacheinfo', `100644,${String(blob).trim()},src/KEPT.txt`);
      git(root, 'commit', '-qm', 'collision');
    },
  ],
  [
    'extended attributes and an access control list',
    cloned,
    'HEAD',
    () => {
      for (const path of ['src/kept.txt', 'src', 'package.json'])
        execFileSync('/usr/bin/xattr', ['-w', 'user.stim-test', 'value', join(root, path)]);
      execFileSync('/bin/chmod', ['+a', 'everyone allow read', join(root, 'src/kept.txt')]);
    },
  ],
  [
    'a folder replaced by an absolute link to its renamed self',
    cloned,
    'HEAD',
    () => {
      renameSync(join(root, 'src'), join(root, 'moved'));
      symlinkSync(join(root, 'moved'), join(root, 'src'));
      chmodSync(join(root, 'moved/kept.txt'), 0o600);
    },
  ],
  ['core.autocrlf=true', checkedOut, 'HEAD', () => git(root, 'config', 'core.autocrlf', 'true')],
  [
    'core.autocrlf written as a bare key',
    checkedOut,
    'HEAD',
    () =>
      writeFileSync(
        join(root, '.git/config'),
        `${readFileSync(join(root, '.git/config'), 'utf-8')}[core]\n\tautocrlf\n`,
      ),
  ],
  [
    'core.autocrlf=1 set only for the new branch',
    checkedOut,
    'HEAD',
    () => {
      write(base, 'branch.config', '[core]\n\tautocrlf = 1\n');
      git(root, 'config', 'includeIf.onbranch:added.path', join(base, 'branch.config'));
      git(root, 'config', 'includeIf.onbranch:plain.path', join(base, 'branch.config'));
    },
  ],
  [
    'core.attributesFile naming an untracked file of the checkout',
    checkedOut,
    'HEAD',
    () => {
      write(root, 'local.attributes', '*.txt text eol=crlf\n');
      git(root, 'config', 'core.attributesFile', 'local.attributes');
    },
  ],
  [
    'core.attributesFile naming a file of the new worktree through a link',
    checkedOut,
    'HEAD',
    () => {
      write(root, 'local.attributes', '*.txt text eol=crlf\n');
      symlinkSync(base, join(base, 'alias'));
      git(root, 'config', 'core.attributesFile', join(base, 'alias/added/local.attributes'));
    },
  ],
  [
    'core.attributesFile that is a link to a file of the new worktree',
    checkedOut,
    'HEAD',
    () => {
      write(root, 'local.attributes', '*.txt text eol=crlf\n');
      symlinkSync(join(base, 'added/local.attributes'), join(base, 'attributes-link'));
      git(root, 'config', 'core.attributesFile', join(base, 'attributes-link'));
    },
  ],
  [
    'core.symlinks=false and a link kept as a file',
    checkedOut,
    'HEAD',
    () => {
      symlinkSync('kept.txt', join(root, 'src/link'));
      git(root, 'add', 'src/link');
      git(root, 'commit', '-qm', 'link');
      git(root, 'config', 'core.symlinks', 'false');
    },
  ],
  ['core.eol=crlf', checkedOut, 'HEAD', () => git(root, 'config', 'core.eol', 'crlf')],
  [
    'GIT_CONFIG_GLOBAL naming a tracked file that sets core.autocrlf=true',
    checkedOut,
    'HEAD',
    () => {
      write(root, 'repo.gitconfig', '[core]\n\tautocrlf = true\n');
      git(root, 'add', 'repo.gitconfig');
      git(root, 'commit', '-qm', 'config');
      git(root, 'config', '--unset', 'core.autocrlf');
      vi.stubEnv('GIT_CONFIG_GLOBAL', 'repo.gitconfig');
    },
  ],
  [
    'attr.tree naming attributes of another branch',
    checkedOut,
    'HEAD',
    () => {
      git(root, 'checkout', '-q', '-b', 'attributes');
      commitAttributes('*.txt text eol=crlf\n');
      git(root, 'checkout', '-q', 'main');
      git(root, 'config', 'attr.tree', 'attributes');
    },
  ],
];

for (const [name, path, commit, prepare] of unlikeACheckout)
  test.skipIf(process.platform !== 'darwin')(
    `a source checkout with ${name} gives what git worktree add then warm gives, in bytes, modes, names and extended attributes (APFS names, xattr and ACLs; darwin only)`,
    async () => {
      prepare();
      const source = tree(root);
      const acl = (dir: string) => execFileSync('/bin/ls', ['-leR', join(dir, 'src')], { encoding: 'utf-8' });

      const added = await run(addOp, root, ['-b', 'added', '../added', commit]);

      expect(added.stderr).toContain(path);
      expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain', commit)));
      expect(acl(join(base, 'added')).replaceAll(join(base, 'added'), '')).not.toContain('everyone allow read');
      expect(git(join(base, 'added'), 'status', '--porcelain')).toBe(git(join(base, 'plain'), 'status', '--porcelain'));
      expect(tree(root)).toEqual(source);
    },
    60_000,
  );

test.skipIf(process.platform !== 'darwin')(
  'a file the source checkout marks immutable is cloned without its flag or its extended attributes (chflags and xattr; darwin only)',
  async () => {
    execFileSync('/usr/bin/xattr', ['-w', 'user.stim-test', 'value', join(root, 'src/kept.txt')]);
    chmodSync(join(root, 'package.json'), 0o600);
    // .gitignore is the first tracked file, the one the command clones to test the volume.
    const flagged = ['src/kept.txt', 'package.json', '.gitignore'];
    for (const file of flagged) execFileSync('/usr/bin/chflags', ['uchg', join(root, file)]);
    try {
      const added = await run(addOp, root, ['-b', 'added', '../added']);

      expect(added.stderr).toContain(cloned);
      expect(readdirSync(base).filter((name) => name.startsWith('.stim-clone-'))).toEqual([]);
      expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));
      rmSync(join(base, 'added/src/kept.txt'));
      rmSync(join(base, 'added/package.json'));
    } finally {
      for (const file of flagged) execFileSync('/usr/bin/chflags', ['nouchg', join(root, file)]);
    }
  },
  60_000,
);

test.skipIf(!clones)(
  'a commit that names .git is left to git, which refuses it, and the source checkout is untouched (needs a volume that clones)',
  async () => {
    const blob = git(root, 'rev-parse', 'HEAD:package.json');
    const made = execFileSync('git', ['-C', root, 'mktree'], {
      input: `100644 blob ${blob}\t.git\n100644 blob ${blob}\tpackage.json\n`,
      encoding: 'utf-8',
    }).trim();
    const commit = git(root, 'commit-tree', '-m', 'names .git', made);
    write(root, 'staged.txt', 'staged and not committed\n');
    git(root, 'add', 'staged.txt');
    mkdirSync(join(root, '.worktrees'));
    const source = tree(root);
    const status = git(root, 'status', '--porcelain');

    const added = await run(addOp, root, ['-b', 'added', '.worktrees/added', commit]);

    expect(added.code).toBe(1);
    expect(added.stderr).toContain("invalid path '.git'");
    expect(git(root, 'status', '--porcelain')).toBe(status);
    expect(tree(root)).toEqual(source);
  },
  60_000,
);

test.skipIf(!clones)(
  'a cloned worktree gets the permission bits a checkout gives under the umask in force (needs a volume that clones)',
  async () => {
    const umask = process.umask(0o027);
    try {
      expect((await run(addOp, root, ['-b', 'added', '../added'])).stderr).toContain(cloned);
      expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain')));
      expect(lstatSync(join(base, 'added/src/kept.txt')).mode & 0o7777).toBe(0o640);
    } finally {
      process.umask(umask);
    }
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'a new path on another volume takes the plain path, names the reason and leaves nothing beside it',
  async () => {
    const real = getExecutor();
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        if (file !== binaryPath()) return real.runFileAsync(file, args, opts);
        const results = [
          { cloned: false, reason: 'cross-device', code: 'EXDEV', message: 'Cross-device link', path: '' },
        ];
        throw Object.assign(new Error('Command failed'), { status: 1, stdout: JSON.stringify({ results }) });
      },
    });

    const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);
    resetExecutor();

    expect(added.code).toBe(0);
    expect(added.stderr).toContain(
      `created ${join(base, 'added')} with git worktree add, because the source and the destination are on different volumes (cross-device, EXDEV)`,
    );
    expect(readdirSync(base).toSorted()).toEqual(['added', 'home', 'main']);
    expect(tree(join(base, 'added'))).toEqual(tree(await plain('plain', 'HEAD~1')));
  },
  60_000,
);

test('a folder with a link into the source checkout, where the commit has a file, costs the source nothing', async () => {
  write(root, 'swap', 'a file at this commit\n');
  git(root, 'add', 'swap');
  git(root, 'commit', '-qm', 'swap is a file');
  git(root, 'rm', '-q', 'swap');
  git(root, 'commit', '-qm', 'swap is gone');
  mkdirSync(join(root, 'swap'));
  // On Windows a junction, which Git for Windows deletes through when it replaces the folder with the file.
  symlinkSync(join(root, 'src'), join(root, 'swap/link'), 'junction');

  symlinkSync(join(root, 'node_modules/pkg'), join(root, 'node_modules/linked'), 'junction');

  const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(clones ? 'as a clone of' : 'with git worktree add');
  // Windows: a junction is absolute, and it leads into the new worktree after a clone as after a copy.
  expect(realpathSync(join(base, 'added/node_modules/linked'))).toBe(
    join(process.platform === 'win32' ? join(base, 'added') : root, 'node_modules/pkg'),
  );
  expect(readFileSync(join(base, 'added/swap'), 'utf-8')).toBe('a file at this commit\n');
  expect(readFileSync(join(root, 'src/kept.txt'), 'utf-8')).toBe('second\n');
  expect(git(root, 'status', '--porcelain')).toBe('?? swap/');
}, 60_000);

test.skipIf(!clones || process.platform !== 'linux')(
  'under a set-group-ID folder git creates the worktree, whose folders inherit the bit (Linux mkdir on a volume that clones)',
  async () => {
    mkdirSync(join(base, 'shared'));
    chmodSync(join(base, 'shared'), 0o2755);

    const added = await run(addOp, root, ['-b', 'added', '../shared/added']);

    expect(added.code).toBe(0);
    expect(added.stderr).toContain('with git worktree add, because cloning failed (');
    expect(lstatSync(join(base, 'shared/added/src')).mode & 0o7777).toBe(0o2755);
    expect(readdirSync(join(base, 'shared/added')).filter((name) => name.startsWith('.stim-'))).toEqual([]);
  },
  60_000,
);

test('a source checkout with a split index takes the plain path and gives the same worktree', async () => {
  git(root, 'update-index', '--split-index');

  const added = await run(addOp, root, ['-b', 'added', '../added', 'HEAD~1']);

  expect(added.code).toBe(0);
  expect(added.stderr).toContain(
    `with git worktree add, because ${process.platform === 'win32' ? plainReason : 'the source checkout uses a split index'}`,
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
    expect(texts(join(base, 'failing'), '.env', 'cache/made-by-hook', 'node_modules/pkg/index.js')).toEqual({
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
  'a cloned worktree keeps the cloned files and its index describes them when the command returns (needs a volume that clones)',
  async () => {
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
  'the source checkout is claimed from before git registers the worktree until the warm has checked what it carried, and free for the hook (needs a volume that clones)',
  async () => {
    const real = getExecutor();
    const readers: [string, number][] = [];
    let refreshCouldStart = false;
    setExecutor({
      ...real,
      async runFileAsync(file, args, opts) {
        const step = ['--no-checkout', 'update-index', '--untracked-files=normal', 'hook'].find((arg) =>
          args.includes(arg),
        );
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
      ['update-index', 1],
      ['--untracked-files=normal', 1],
      ['hook', 0],
    ]);
    expect(refreshCouldStart).toBe(true);
  },
  60_000,
);

test.skipIf(!clones)(
  'an operation that waits for the source claim creates nothing if cancelled, and never deletes a branch made meanwhile (needs a volume that clones)',
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
        const pairs = clonesInto(join(base, 'made-while-waiting'), file, opts);
        if (pairs.length) throw notCloned(pairs);
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
  'an operation cancelled during the clone or the checkout reads beside it leaves no worktree and no branch, and one cancelled during the carry leaves no ignored file (needs a volume that clones)',
  async () => {
    const real = getExecutor();
    const cancelAt = async (
      during: (file: string, args: string[], opts: { input?: string }) => boolean,
      path: string,
    ) => {
      const controller = new AbortController();
      setExecutor({
        ...real,
        async runFileAsync(file, args, opts) {
          const output = await real.runFileAsync(file, args, opts);
          if (during(file, args, opts)) controller.abort();
          return output;
        },
      });
      const stim = createStim({ projectRoot: root, env: { ...process.env } });
      await expect(stim.addWorktree({ path, branch: path.slice(3), signal: controller.signal })).rejects.toMatchObject({
        code: 'STIM_CANCELLED',
      });
      resetExecutor();
    };

    await cancelAt((file, _args, opts) => clonesInto(join(base, 'cloning'), file, opts).length > 0, '../cloning');
    expect(existsSync(join(base, 'cloning'))).toBe(false);
    expect(git(root, 'branch', '--list', 'cloning')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);

    await cancelAt(
      (file, _args, opts) => file === binaryPath() && (opts.input ?? '').endsWith('/index\0'),
      '../reading',
    );
    expect(existsSync(join(base, 'reading'))).toBe(false);
    expect(git(root, 'branch', '--list', 'reading')).toBe('');
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
