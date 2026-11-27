import type { StimContext } from '@stim-cli/core';
import { chmodSync, lchmodSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { isPathPrefix } from '@stim-cli/core/state';
import { dirname, isAbsolute, join } from 'node:path';
import { runOperationFile } from '../engine/operation-exec.ts';
import { getExecutor } from '../exec.ts';
import { childEnvironment } from './git-read.ts';
import { gitAsync } from './git.ts';

const CONVERSION_ATTRIBUTES = ['eol', 'ident', 'filter', 'working-tree-encoding'];
const XATTR_PATHS_PER_CALL = 1000;
const XATTR_CALLS_AT_ONCE = 4;

async function refuseCheckoutConfig(target: string, operation: StimContext): Promise<void> {
  const get = async (name: string, type: string, unset: string) =>
    (
      await gitAsync(target, ['config', `--type=${type}`, `--default=${unset}`, '--get', name], {
        ...childEnvironment(operation.env),
        signal: operation.signal,
        declareFor: operation,
      })
    )
      .trim()
      .toLowerCase();
  const [autocrlf, eol, symlinks, tree, attributesFile] = await Promise.all([
    get('core.autocrlf', 'bool-or-str', 'false'),
    get('core.eol', 'path', 'lf'),
    get('core.symlinks', 'bool', 'true'),
    get('attr.tree', 'path', ''),
    get('core.attributesFile', 'path', ''),
  ]);
  // git convert.c output_eol and text_eol_is_crlf: a checkout writes CRLF for a path no attribute names only under
  // core.autocrlf=true or core.eol=crlf. core.autocrlf=input converts nothing at checkout.
  if (autocrlf === 'true' || eol === 'crlf') throw new Error('core.autocrlf or core.eol makes a checkout write CRLF');
  // git-config(1), core.symlinks: when false a checkout writes a link as a file that holds its target.
  if (symlinks !== 'true') throw new Error('core.symlinks=false makes a checkout write links as files');
  // gitattributes(5): attr.tree and GIT_ATTR_SOURCE name a tree whose attributes replace the working tree's.
  if (tree || operation.env.GIT_ATTR_SOURCE)
    throw new Error('attr.tree or GIT_ATTR_SOURCE names another source of attributes');
  // git-config(1), core.attributesFile: read beside the commit's attributes, so one inside the worktree is a file
  // the clone brought from the source checkout.
  if (attributesFile && (!isAbsolute(attributesFile) || isPathPrefix(target.toLowerCase(), attributesFile)))
    throw new Error('core.attributesFile names a file in the worktree');
}

/**
 * Makes the tracked files of `target`, a worktree whose files were cloned from another checkout, what
 * `git worktree add` writes for its `HEAD`, or removes them so `git reset --hard` writes them: a file a checkout
 * converts or whose size is not its blob's, and a file whose name is spelled another way on disk, are removed;
 * permission bits and extended attributes are set to a new file's. Throws where that takes more than a file.
 * @ref LLP 0029#a-clone-is-kept-only-as-a-checkout-writes-it -- every difference is removed or left to git
 */
export async function cloneAsCheckout(target: string, operation: StimContext): Promise<void> {
  await refuseCheckoutConfig(target, operation);
  await asCheckout(target, operation).catch(async (error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    // chflags(1): a file with the uchg flag, which clonefile(2) copies, cannot be changed or removed until the flag
    // is cleared. -R does not follow links.
    await runOperationFile(operation, getExecutor(), '/usr/bin/chflags', ['-R', 'nouchg', target], {
      timeoutMs: 'unbounded',
    });
    await asCheckout(target, operation);
  });
}

async function asCheckout(target: string, operation: StimContext): Promise<void> {
  const read = { ...childEnvironment(operation.env), signal: operation.signal, declareFor: operation, untrimmed: true };
  // git(1), GIT_NO_LAZY_FETCH: in a partial clone ls-tree -l otherwise fetches each missing blob for its size, one
  // at a time. Without it the size is not a number and the file is left to the reset, which fetches in one batch.
  const entries = (
    await gitAsync(target, ['ls-tree', '-r', '-l', '-z', 'HEAD'], {
      ...read,
      env: { ...read.env, GIT_NO_LAZY_FETCH: '1' },
      timeoutMs: 'unbounded',
    })
  )
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [mode = '', , , size = ''] = record.slice(0, record.indexOf('\t')).split(/ +/);
      return { mode, size: Number(size), path: record.slice(record.indexOf('\t') + 1) };
    });
  const directories = new Set<string>();
  for (const { path } of entries)
    for (let parent = dirname(path); parent !== '.' && !directories.has(parent); parent = dirname(parent))
      directories.add(parent);
  const folded = new Set<string>();
  for (const path of [...directories, ...entries.map((entry) => entry.path)]) {
    const key = path.normalize('NFC').toLowerCase();
    // git read-cache.c verify_path: a checkout refuses a path with a .git component, in any case and through the
    // code points HFS+ ignores, which ls-tree still lists.
    if (/(^|\/)(\.git|git~1|\.\.?)$/.test(key.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '')))
      throw new Error('a tracked path names .git or a parent folder');
    if (folded.has(key)) throw new Error('two tracked paths differ only in case or Unicode form');
    folded.add(key);
  }
  // git-check-attr(1): --source reads .gitattributes from that commit, as the refresh and the reset after this do.
  // Each path comes back once per attribute, in the order asked.
  const attributes = (
    await gitAsync(target, ['check-attr', '-z', '--stdin', '--source=HEAD', ...CONVERSION_ATTRIBUTES], {
      ...read,
      timeoutMs: 'unbounded',
      input: entries.map((entry) => `${entry.path}\0`).join(''),
    })
  ).split('\0');
  if (attributes.length < entries.length * CONVERSION_ATTRIBUTES.length * 3)
    throw new Error('git did not answer for every tracked path');
  // git entry.c create_file and create_directories: a checkout creates a file with mode 0666, or 0777 for an
  // executable one, and a directory with 0777, each less the umask.
  const umask = process.umask();
  const listings = new Map<string, Set<string>>();
  const present = (path: string): boolean => {
    const parent = dirname(path) === '.' ? '' : dirname(path);
    let names = listings.get(parent);
    if (!names) {
      names = new Set(readdirSync(join(target, parent)));
      listings.set(parent, names);
    }
    return names.has(path.slice(parent ? parent.length + 1 : 0));
  };
  const real = new Set(['.']);
  const kept: string[] = [];
  for (const directory of [...directories].toSorted()) {
    if (!real.has(dirname(directory))) continue;
    const found = lstatSync(join(target, directory), { throwIfNoEntry: false });
    if (!found) continue;
    if (!found.isDirectory()) unlinkSync(join(target, directory));
    else if (!present(directory)) throw new Error(`the directory ${directory} is spelled another way on disk`);
    else {
      if ((found.mode & 0o7777) !== (0o777 & ~umask)) chmodSync(join(target, directory), 0o777 & ~umask);
      real.add(directory);
      kept.push(directory);
    }
  }
  entries.forEach(({ mode, size, path }, n) => {
    if (n % 1024 === 0) operation.signal.throwIfAborted();
    if (mode === '160000' || !real.has(dirname(path))) return;
    const file = join(target, path);
    const found = lstatSync(file, { throwIfNoEntry: false });
    if (!found) return;
    if (!present(path)) {
      if (found.isDirectory()) throw new Error(`${path} is a directory spelled another way on disk`);
      return unlinkSync(file);
    }
    if (mode === '120000' ? !found.isSymbolicLink() : !found.isFile()) return;
    // symlink(2): a link is created with mode 0777 less the umask.
    if (mode === '120000' && (found.mode & 0o7777) !== (0o777 & ~umask)) lchmodSync(file, 0o777 & ~umask);
    if (mode !== '120000') {
      const [eol, ...others] = CONVERSION_ATTRIBUTES.map(
        (_, attribute) => attributes[(n * CONVERSION_ATTRIBUTES.length + attribute) * 3 + 2],
      );
      if (
        !['unspecified', 'unset', 'lf'].includes(eol ?? '') ||
        others.some((value) => value !== 'unspecified' && value !== 'unset') ||
        found.size !== size
      )
        return unlinkSync(file);
      const expected = (mode === '100755' ? 0o777 : 0o666) & ~umask;
      if ((found.mode & 0o7777) !== expected) chmodSync(file, expected);
    }
    kept.push(path);
  });
  // xattr(1): -c removes every extended attribute and -s acts on a link instead of the file it names. clonefile(2)
  // copies extended attributes, which a file a checkout creates does not have. chflags(1): a file with the uchg
  // flag, which clonefile(2) copies too, refuses the change until the flag is cleared; -h acts on a link itself.
  const batches: string[][] = [];
  for (let at = 0; at < kept.length; at += XATTR_PATHS_PER_CALL)
    batches.push(kept.slice(at, at + XATTR_PATHS_PER_CALL).map((path) => `./${path}`));
  const run = (file: string, args: string[]) =>
    runOperationFile(operation, getExecutor(), file, args, { timeoutMs: 'unbounded', cwd: target });
  await Promise.all(
    Array.from({ length: XATTR_CALLS_AT_ONCE }, async () => {
      for (let batch = batches.pop(); batch; batch = batches.pop()) {
        const paths = batch;
        await run('/usr/bin/xattr', ['-c', '-s', ...paths]).catch(async () => {
          operation.signal.throwIfAborted();
          await run('/usr/bin/chflags', ['-h', 'nouchg', ...paths]);
          await run('/usr/bin/xattr', ['-c', '-s', ...paths]);
        });
      }
    }),
  );
}
