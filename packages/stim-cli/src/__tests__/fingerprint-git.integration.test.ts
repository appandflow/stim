import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackedPaths, parseGitIndex } from '../fingerprint/git-index.ts';
import { staticInputs } from '../fingerprint/inputs.ts';
import { isUncertain, preimage, preimageHash } from '../fingerprint/key.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const GIT_CONFIG = [
  'user.name=t',
  'user.email=t@example.com',
  'maintenance.auto=false',
  'gc.auto=0',
  'commit.gpgsign=false',
].flatMap((setting) => ['-c', setting]);

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...GIT_CONFIG, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  });

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-git-')));
  temps.push(root, `${root}-wt`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'init');
  return root;
}

const lsFiles = (dir: string) =>
  new Set(
    git(dir, 'ls-files', '-z', '-c')
      .split('\0')
      .filter(Boolean)
      .map((path) => join(dir, path)),
  );

describe('git index reader', () => {
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`ios/App/Generated/Sources/Module${i % 4}/File${i}.swift`, `${i}`]),
  );

  test.each([
    ['version 2', 2, ['update-index', '--index-version', '2']],
    [
      'version 3 with extended flags',
      3,
      ['update-index', '--index-version', '3', '--skip-worktree', 'ios/App/Generated/Sources/Module1/File1.swift'],
    ],
    ['version 4 with prefix-compressed names', 4, ['update-index', '--index-version', '4']],
  ])('reads %s as git ls-files lists it', async (_case, version, args) => {
    const root = repo({ ...files, [`caf${String.fromCodePoint(0xe9)}.txt`]: 'x' });
    git(root, ...args);
    const index = readFileSync(join(root, '.git/index'));
    expect(index.readUInt32BE(4)).toBe(version);
    expect(/^S /m.test(git(root, 'ls-files', '-v'))).toBe(version === 3);
    expect(parseGitIndex(index)).not.toBeNull();
    expect(await trackedPaths(root)).toEqual(lsFiles(root));
  });

  test('leaves a split index to git ls-files and reads a linked worktree', async () => {
    const root = repo(files);
    git(root, 'update-index', '--split-index');
    expect(parseGitIndex(readFileSync(join(root, '.git/index')))).toBeNull();
    expect(await trackedPaths(root)).toEqual(lsFiles(root));
    git(root, 'worktree', 'add', '--quiet', '--detach', `${root}-wt`, 'HEAD');
    expect(await trackedPaths(join(`${root}-wt`, 'ios'))).toEqual(lsFiles(`${root}-wt`));
  });
});

test('a fresh worktree keys alike before and after pod install writes the ignored workspace and Pods', async () => {
  const root = repo({
    '.gitignore': 'ios/*.xcworkspace/\nios/Pods/\n',
    'package.json': '{"name":"app"}',
    'ios/Podfile': "platform :ios, '16.0'\n",
    'ios/Podfile.lock': 'PODS:\n  - React (0.88.0)\n\nCOCOAPODS: 1.16.2\n',
    'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n',
  });
  const worktree = `${root}-wt`;
  git(root, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  const key = async (dir: string) => {
    const result = staticInputs(
      { root: dir, tracked: await trackedPaths(dir), expoResolves: false },
      { platform: 'ios' },
    );
    if (isUncertain(result)) throw new Error(result.uncertain);
    return preimageHash(preimage('ios', result.native, result.layout, result.inputs));
  };
  const fresh = await key(worktree);
  for (const dir of [root, worktree]) {
    mkdirSync(join(dir, 'ios/App.xcworkspace/xcshareddata'), { recursive: true });
    writeFileSync(join(dir, 'ios/App.xcworkspace/contents.xcworkspacedata'), `<Workspace location="${dir}"/>\n`);
    mkdirSync(join(dir, 'ios/Pods'), { recursive: true });
    writeFileSync(join(dir, 'ios/Pods/Manifest.lock'), 'PODS:\n');
  }
  expect(await key(worktree)).toBe(fresh);
  expect(await key(root)).toBe(fresh);

  git(root, 'add', '--force', 'ios/App.xcworkspace/contents.xcworkspacedata');
  expect(await key(root)).not.toBe(fresh);
});
