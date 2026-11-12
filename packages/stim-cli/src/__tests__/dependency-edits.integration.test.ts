import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import {
  checkDependencyEdits,
  noteEditsBeforeInstall,
  recordDependencyInstall,
} from '../workspace/dependency-edits.ts';

const HOUR = 60 * 60_000;
let home: string;
let worktree: string;
let tree: string;

function write(path: string, text = 'installed', at?: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (at) utimesSync(path, at, at);
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function installAt(at: Date): void {
  write(join(tree, 'pkg', 'package.json'), '{"main":"index.js"}', at);
  write(join(tree, 'pkg', 'index.js'), 'installed', at);
  write(join(tree, 'pkg', 'android', 'build.gradle'), 'apply plugin', at);
  write(join(tree, '.package-lock.json'), '{}', at);
}

function keptFor(check: Awaited<ReturnType<typeof checkDependencyEdits>>): string {
  if (!('keep' in check)) throw new Error(`expected a keep, got ${JSON.stringify(check)}`);
  return check.keep;
}

function savedOf(check: Awaited<ReturnType<typeof checkDependencyEdits>>): string[] {
  if (!('delete' in check) || !check.saved) throw new Error(`expected a save, got ${JSON.stringify(check)}`);
  return check.saved.files;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  tree = join(worktree, 'node_modules');
  process.env.STIM_HOME = home;
  process.env.STIM_ARCHIVE_ENABLED = 'true';
});

afterEach(() => {
  chmodSync(worktree, 0o755);
  for (const dir of [join(tree, 'pkg', 'locked')]) {
    try {
      chmodSync(dir, 0o755);
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_ARCHIVE_ENABLED;
});

test('an untouched tree is deleted; Gradle and pnpm output does not keep it, a JS build directory beside a Gradle script does', async () => {
  installAt(ago(HOUR));
  write(join(tree, 'pkg', 'android', 'build', 'intermediates', 'classes.jar'));
  write(join(tree, 'pkg', 'android', '.cxx', 'Debug', 'build.ninja'));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build.gradle.kts'), 'x', ago(2 * HOUR));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build', 'tmp', 'jar', 'MANIFEST.MF'));
  write(join(tree, '.pnpm', 'lock.yaml'));
  write(join(tree, '.cache', 'babel', 'entry.json'));
  write(join(tree, '.vitest-cache', 'results.json'));

  expect(await checkDependencyEdits(tree, { level: 'high', worktree })).toEqual({ delete: true });

  write(join(tree, 'hybrid', 'package.json'), '{"main":"build/index.js"}', ago(2 * HOUR));
  write(join(tree, 'hybrid', 'build.gradle'), 'x', ago(2 * HOUR));
  write(join(tree, 'hybrid', 'build', 'index.js'), 'patched by hand');
  write(join(tree, 'hybrid', 'build', 'tmp', 'x.bin'), 'x', ago(2 * HOUR));

  expect(keptFor(await checkDependencyEdits(tree, { level: 'high', worktree }))).toContain('hybrid/build/index.js');
});

test('an edit stays an edit after a later install rewrites the stamp, while a package that install replaced does not count', async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  installAt(ago(0));
  await pause();
  recordDependencyInstall([tree]);
  await pause();
  write(join(tree, 'pkg', 'index.js'), 'patched by hand');
  await pause();
  write(join(tree, 'upgraded', 'package.json'), '{}');
  write(join(tree, 'upgraded', 'index.js'), 'new version');
  await pause();
  write(join(tree, '.package-lock.json'), '{}');

  expect(savedOf(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toEqual(['pkg/index.js']);
});

test('with no record, an edit stays an edit after a later install rewrites the stamp in place', async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  installAt(ago(0));
  await pause();
  write(join(tree, 'pkg', 'index.js'), 'patched by hand');
  await pause();
  writeFileSync(join(tree, '.package-lock.json'), '{"rewritten":true}');

  expect(savedOf(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toEqual(['pkg/index.js']);
});

test('in a tree no stamp covers, an edit in the first minute does not keep it but is saved at critical', async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  write(join(tree, 'pkg', 'package.json'), '{}');
  write(join(tree, 'pkg', 'index.js'), 'installed');
  mkdirSync(join(tree, '.bin'));
  await pause();
  write(join(tree, 'pkg', 'index.js'), 'patched by hand');

  expect(await checkDependencyEdits(tree, { level: 'high', worktree, readOnly: true })).toEqual({ delete: true });
  expect(savedOf(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toEqual(['pkg/index.js']);
});

test('an edit stays an edit after Stim runs an install that leaves it in place', async () => {
  installAt(ago(2 * HOUR));
  recordDependencyInstall([tree], ago(2 * HOUR).getTime());
  write(join(tree, 'pkg', 'index.js'), 'patched by hand', ago(HOUR));

  await noteEditsBeforeInstall([tree]);
  write(join(tree, '.package-lock.json'), '{}');
  recordDependencyInstall([tree]);

  expect(keptFor(await checkDependencyEdits(tree, { level: 'high', worktree }))).toContain('pkg/index.js');
});

test.each([
  { script: false, high: 'keep', critical: ['pkg/index.js'] },
  { script: true, high: 'delete', critical: ['pkg/index.js'] },
])(
  'an edit a minute after the stamp, with an install script $script: $high below critical, saved at critical',
  async ({ script, high, critical }) => {
    installAt(ago(2 * 60_000));
    write(join(worktree, 'package.json'), JSON.stringify(script ? { scripts: { postinstall: 'patch-package' } } : {}));
    write(join(tree, 'pkg', 'index.js'), 'patched by hand', ago(60_000));

    const below = await checkDependencyEdits(tree, { level: 'high', worktree });
    expect('keep' in below ? 'keep' : 'delete').toBe(high);
    expect(savedOf(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toEqual(critical);
  },
);

test.skipIf(process.platform === 'win32')(
  'at critical the edits are saved, and the printed command puts them back after a reinstall',
  async () => {
    installAt(ago(HOUR));
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
    expect(readdirSync(join(tree, 'pkg')).toSorted()).toEqual(['android', 'index.js', 'lib', 'package.json']);
  },
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'at critical a tree is kept when a directory in it cannot be listed, naming it',
  async () => {
    installAt(ago(HOUR));
    write(join(tree, 'pkg', 'locked', 'index.js'), 'patched by hand');
    chmodSync(join(tree, 'pkg', 'locked'), 0o000);

    expect(keptFor(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toContain(
      join(tree, 'pkg', 'locked'),
    );
  },
);

test('at critical a tree with more changed files than maintenance saves is kept', async () => {
  installAt(ago(HOUR));
  for (let i = 0; i <= 1000; i++) write(join(tree, 'pkg', 'gen', `${i}.js`), 'x');

  expect(keptFor(await checkDependencyEdits(tree, { level: 'critical', worktree }))).toContain(
    'stays even at critical pressure',
  );
});
