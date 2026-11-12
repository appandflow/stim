import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJsonObject } from '@stim-cli/core/state';
import { checkDependencyEdits, INSTALL_GRACE_MS, recordDependencyInstall } from '../workspace/dependency-edits.ts';

let home: string;
let worktree: string;
let tree: string;

function write(path: string, text = 'installed', at?: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (at) utimesSync(path, at, at);
}

function installAt(at: Date): void {
  write(join(tree, 'pkg', 'index.js'), 'installed', at);
  write(join(tree, 'pkg', 'android', 'build.gradle'), 'apply plugin', at);
  write(join(tree, '.package-lock.json'), '{}', at);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  tree = join(worktree, 'node_modules');
  process.env.STIM_HOME = home;
  process.env.STIM_ARCHIVE_ENABLED = 'true';
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_ARCHIVE_ENABLED;
});

test('an untouched tree is deleted, and build output and pnpm state written after the install do not keep it', async () => {
  installAt(new Date(Date.now() - 60 * 60_000));
  write(join(tree, 'pkg', 'android', 'build', 'intermediates', 'classes.jar'));
  write(join(tree, 'pkg', 'android', '.cxx', 'Debug', 'build.ninja'));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build.gradle.kts'), 'x', new Date(0));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build', 'libs', 'shared.jar'));
  write(join(tree, '.pnpm', 'lock.yaml'));
  write(join(tree, '.cache', 'babel', 'entry.json'));

  expect(await checkDependencyEdits(tree, { level: 'high', worktree })).toEqual({ delete: true });
});

test('a file edited after the install keeps the tree below critical and names it', async () => {
  installAt(new Date(Date.now() - 60 * 60_000));
  write(join(tree, 'pkg', 'index.js'), 'patched by hand');

  const check = await checkDependencyEdits(tree, { level: 'high', worktree });

  expect(check).toMatchObject({ edited: true });
  expect('keep' in check && check.keep).toContain('1 file in it changed after its install (pkg/index.js)');
});

test('a root postinstall that ran after the stamp does not keep the tree when Stim ran the install, and an edit after Stim recorded it does', async () => {
  const stamped = new Date(Date.now() - 2 * INSTALL_GRACE_MS);
  installAt(stamped);
  write(
    join(tree, 'pkg', 'patched.js'),
    'patch-package output',
    new Date(stamped.getTime() + INSTALL_GRACE_MS + 60_000),
  );

  expect(await checkDependencyEdits(tree, { level: 'high', worktree })).toMatchObject({ edited: true });

  recordDependencyInstall([tree], stamped.getTime() + INSTALL_GRACE_MS + 120_000);
  expect(await checkDependencyEdits(tree, { level: 'high', worktree })).toEqual({ delete: true });

  write(join(tree, 'pkg', 'index.js'), 'patched by hand');
  expect(await checkDependencyEdits(tree, { level: 'high', worktree })).toMatchObject({ edited: true });
});

test.skipIf(process.platform === 'win32')(
  'at critical the edited files are saved before the tree goes, and the printed command puts them back after a reinstall',
  async () => {
    installAt(new Date(Date.now() - 60 * 60_000));
    write(join(tree, 'pkg', 'index.js'), 'patched by hand');
    write(join(tree, 'pkg', 'lib', 'new file.js'), 'added by hand');

    const check = await checkDependencyEdits(tree, { level: 'critical', worktree });
    if (!('delete' in check) || !check.saved) throw new Error(`expected a save, got ${JSON.stringify(check)}`);
    expect(check.saved.files).toEqual(['pkg/index.js', 'pkg/lib/new file.js']);
    expect(readJsonObject(join(check.saved.dir, 'manifest.json'))).toMatchObject({
      kind: 'dependency-edits',
      source: tree,
      pressure: 'critical',
      files: ['pkg/index.js', 'pkg/lib/new file.js'],
    });

    rmSync(tree, { recursive: true, force: true });
    installAt(new Date());
    execFileSync('sh', ['-c', check.saved.restore]);

    expect(readFileSync(join(tree, 'pkg', 'index.js'), 'utf8')).toBe('patched by hand');
    expect(readFileSync(join(tree, 'pkg', 'lib', 'new file.js'), 'utf8')).toBe('added by hand');
    expect(readdirSync(join(tree, 'pkg')).toSorted()).toEqual(['android', 'index.js', 'lib']);
  },
);
