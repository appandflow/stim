import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneStat, readIndex, writeIndex } from '../workspace/git-index.ts';
import type { FileStat, IndexEntry } from '../workspace/git-index.ts';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 15_000 });
}

function write(rel: string, value: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), value);
}

function indexBytes(): Buffer {
  return readFileSync(join(repo, '.git/index'));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'stim-test-index-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (let n = 0; n < 12; n++) write(`packages/shared-prefix/module-${n}/index.js`, `module ${n}\n`);
  write('a', 'short name\n');
  write(`deep/${'long-directory-name/'.repeat(9)}file.txt`, 'a name longer than one length byte of version 4\n');
  write(`deep/${'long-directory-name/'.repeat(9)}other.txt`, 'which drops and appends past 127 bytes\n');
  write('z-last.txt', 'drops the whole previous name\n');
  symlinkSync('a', join(repo, 'link'));
  git('add', '-A');
  git('commit', '-qm', 'fixture');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const formats: [string, () => void][] = [
  ['version 2', () => git('update-index', '--index-version', '2')],
  [
    'version 3, which an intent-to-add entry needs',
    () => {
      write('intended.txt', 'not added yet\n');
      git('add', '-N', 'intended.txt');
    },
  ],
  ['version 4', () => git('update-index', '--index-version', '4')],
];

test.each(formats)('an index of %s is read as git lists it and written back byte for byte', (_name, prepare) => {
  prepare();
  const bytes = indexBytes();

  const index = readIndex(bytes);

  if (!index) throw new Error('the index was not read');
  expect(index.entries.map((entry) => entry.path.toString())).toEqual(
    git('ls-files', '-z').split('\0').filter(Boolean),
  );
  const link = index.entries.find((entry) => entry.path.toString() === 'link');
  expect(link?.mode).toBe(0o120000);
  expect(link?.stat.ino).toBe(Number(BigInt.asUintN(32, lstatSync(join(repo, 'link'), { bigint: true }).ino)));
  expect(index.entries.filter((entry) => entry.intentToAdd).map((entry) => entry.path.toString())).toEqual(
    _name.startsWith('version 3') ? ['intended.txt'] : [],
  );
  expect(
    writeIndex(
      bytes,
      index,
      index.entries.map((entry) => entry.stat),
      () => true,
    ).equals(bytes),
  ).toBe(true);

  const skipHash = Buffer.concat([bytes.subarray(0, bytes.length - 20), Buffer.alloc(20)]);
  const unhashed = readIndex(skipHash);
  if (!unhashed) throw new Error('the index without a checksum was not read');
  expect(
    writeIndex(
      skipHash,
      unhashed,
      unhashed.entries.map((entry) => entry.stat),
      () => true,
    ).equals(skipHash),
  ).toBe(true);
});

test.each(formats)('git accepts a written index of %s with zeroed stat data and fewer extensions', (_name, prepare) => {
  prepare();
  const staged = git('ls-files', '--stage');
  const bytes = indexBytes();
  const index = readIndex(bytes);
  if (!index) throw new Error('the index was not read');
  expect(index.extensions.map((extension) => extension.signature)).toContain('TREE');

  writeFileSync(
    join(repo, '.git/index'),
    writeIndex(
      bytes,
      index,
      index.entries.map((entry, n) => (n % 2 ? entry.stat : null)),
      (signature) => signature === 'TREE',
    ),
  );

  expect(git('ls-files', '--stage')).toBe(staged);
  expect(git('ls-files', '--debug', 'a')).toMatch(/ctime: 0:0\n\s+mtime: 0:0\n\s+dev: 0\tino: 0\n/);
  expect(git('status', '--porcelain', '--untracked-files=no').replace(/^ A intended.txt\n/, '')).toBe('');
  expect(git('fsck', '--no-dangling')).toBe('');
  expect(git('write-tree').trim()).toBe(git('rev-parse', 'HEAD^{tree}').trim());
});

test('an index this cannot vouch for is not read', () => {
  const bytes = indexBytes();
  const flipped = Buffer.from(bytes);
  flipped.writeUInt8(flipped.readUInt8(20) ^ 1, 20);
  const version5 = Buffer.from(bytes);
  version5.writeUInt32BE(5, 4);
  const oneEntryMore = Buffer.from(bytes);
  oneEntryMore.writeUInt32BE(oneEntryMore.readUInt32BE(8) + 1, 8);
  oneEntryMore.fill(0, oneEntryMore.length - 20);

  expect(readIndex(flipped)).toBeNull();
  expect(readIndex(version5)).toBeNull();
  expect(readIndex(oneEntryMore)).toBeNull();
  expect(readIndex(bytes.subarray(0, bytes.length - 8))).toBeNull();
  expect(readIndex(Buffer.from('not an index'))).toBeNull();
});

const SECOND = 1_000_000_000n;
const recorded: FileStat = {
  mode: 0o100644n,
  size: 42n,
  mtimeNs: 1_700_000_000n * SECOND + 123n,
  ctimeNs: 1_700_000_005n * SECOND + 456n,
  dev: 16_777_234n,
  ino: (1n << 32n) + 77n,
  uid: 501n,
  gid: 20n,
};
const cloned: FileStat = { ...recorded, ctimeNs: 1_700_000_900n * SECOND + 789n, ino: (1n << 32n) + 99n };
const entry: IndexEntry = {
  offset: 12,
  path: Buffer.from('file.txt'),
  mode: 0o100644,
  stat: {
    ctimeSec: 1_700_000_005,
    ctimeNsec: 456,
    mtimeSec: 1_700_000_000,
    mtimeNsec: 123,
    dev: 16_777_234,
    ino: 77,
    uid: 501,
    gid: 20,
    size: 42,
  },
  oid: '8baef1b4abc478178b004d62031cf7fe6db6f903',
  emptyBlob: false,
  stage: 0,
  assumeUnchanged: false,
  skipWorktree: false,
  intentToAdd: false,
};
const INDEX_WRITTEN = 1_700_000_001;

test('a clone of a file its entry still describes gets the stat data git would record for the clone', () => {
  expect(cloneStat(entry, recorded, cloned, INDEX_WRITTEN)).toEqual({
    ...entry.stat,
    ctimeSec: 1_700_000_900,
    ctimeNsec: 789,
    ino: 99,
  });
  expect(
    cloneStat(
      { ...entry, stat: { ...entry.stat, size: 0 }, emptyBlob: true },
      { ...recorded, size: 0n },
      { ...cloned, size: 0n },
      INDEX_WRITTEN,
    ),
  ).toMatchObject({ size: 0, ino: 99 });
  expect(
    cloneStat({ ...entry, stat: { ...entry.stat, dev: 16_777_233 } }, recorded, cloned, INDEX_WRITTEN),
  ).toMatchObject({ dev: 16_777_234, ino: 99 });
  const link = { ...entry, mode: 0o120000 };
  expect(
    cloneStat(link, { ...recorded, mode: 0o120755n }, { ...cloned, mode: 0o120755n }, INDEX_WRITTEN),
  ).toMatchObject({
    ino: 99,
  });
});

test.each<[string, IndexEntry, FileStat | null, FileStat | null, number]>([
  ['the source file is gone', entry, null, cloned, INDEX_WRITTEN],
  ['the clone is missing', entry, recorded, null, INDEX_WRITTEN],
  [
    'the source changed and kept its size and modification time',
    entry,
    { ...recorded, ctimeNs: recorded.ctimeNs + 1n },
    cloned,
    INDEX_WRITTEN,
  ],
  [
    'the source was modified within the same second',
    entry,
    { ...recorded, mtimeNs: recorded.mtimeNs + 1n },
    { ...cloned, mtimeNs: recorded.mtimeNs + 1n },
    INDEX_WRITTEN,
  ],
  ['the source was replaced by another file', entry, { ...recorded, ino: recorded.ino + 1n }, cloned, INDEX_WRITTEN],
  ['the source changed size', entry, { ...recorded, size: 43n }, { ...cloned, size: 43n }, INDEX_WRITTEN],
  ['the source changed owner', entry, { ...recorded, uid: 0n }, { ...cloned, uid: 0n }, INDEX_WRITTEN],
  [
    'the source became executable',
    entry,
    { ...recorded, mode: 0o100755n },
    { ...cloned, mode: 0o100755n },
    INDEX_WRITTEN,
  ],
  [
    'the source became a symbolic link',
    { ...entry, mode: 0o100755 },
    { ...recorded, mode: 0o120755n },
    { ...cloned, mode: 0o120755n },
    INDEX_WRITTEN,
  ],
  [
    'the entry is a directory of a sparse index',
    { ...entry, mode: 0o040000 },
    { ...recorded, mode: 0o040755n },
    { ...cloned, mode: 0o040755n },
    INDEX_WRITTEN,
  ],
  ['the entry was modified in the second its index was written', entry, recorded, cloned, entry.stat.mtimeSec],
  ['the entry is newer than its index', entry, recorded, cloned, entry.stat.mtimeSec - 5],
  [
    'git marked a changed entry with size 0',
    { ...entry, stat: { ...entry.stat, size: 0 } },
    { ...recorded, size: 0n },
    { ...cloned, size: 0n },
    INDEX_WRITTEN,
  ],
  ['the clone has another size', entry, recorded, { ...cloned, size: 41n }, INDEX_WRITTEN],
  [
    'the clone has another modification time',
    entry,
    recorded,
    { ...cloned, mtimeNs: cloned.mtimeNs + 1n },
    INDEX_WRITTEN,
  ],
  ['the clone has another mode', entry, recorded, { ...cloned, mode: 0o100600n }, INDEX_WRITTEN],
  ['the entry is one side of a conflict', { ...entry, stage: 2 }, recorded, cloned, INDEX_WRITTEN],
  ['the entry is intent-to-add', { ...entry, intentToAdd: true }, recorded, cloned, INDEX_WRITTEN],
  ['the entry is assume-unchanged', { ...entry, assumeUnchanged: true }, recorded, cloned, INDEX_WRITTEN],
  ['the entry is skip-worktree', { ...entry, skipWorktree: true }, recorded, cloned, INDEX_WRITTEN],
  [
    'the entry is a submodule',
    { ...entry, mode: 0o160000 },
    { ...recorded, mode: 0o040755n },
    { ...cloned, mode: 0o040755n },
    INDEX_WRITTEN,
  ],
])('git reads the file when %s', (_name, indexEntry, source, clone, indexMtimeSec) => {
  expect(cloneStat(indexEntry, source, clone, indexMtimeSec)).toBeNull();
});
