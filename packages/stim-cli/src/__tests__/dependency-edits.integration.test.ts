import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function pause(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installAt(at: Date): void {
  write(join(tree, 'pkg', 'package.json'), '{"main":"index.js"}', at);
  write(join(tree, 'pkg', 'index.js'), 'installed', at);
  write(join(tree, 'pkg', 'android', 'build.gradle'), 'apply plugin', at);
  write(join(tree, '.package-lock.json'), '{}', at);
}

async function keptFiles(level: 'high' | 'critical' = 'critical'): Promise<string> {
  const check = await checkDependencyEdits(tree, { level, worktree });
  if (!('keep' in check)) throw new Error(`expected a keep, got ${JSON.stringify(check)}`);
  return check.keep;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  tree = join(worktree, 'node_modules');
  process.env.STIM_HOME = home;
});

afterEach(() => {
  try {
    chmodSync(join(tree, 'pkg', 'locked'), 0o755);
  } catch {}
  rmSync(home, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('an untouched tree is deleted; Gradle, pnpm and tool-cache output does not keep it, a JS build directory beside a Gradle script does', async () => {
  installAt(ago(HOUR));
  write(join(tree, 'pkg', 'android', 'build', 'intermediates', 'classes.jar'));
  write(join(tree, 'pkg', 'android', '.cxx', 'Debug', 'build.ninja'));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build.gradle.kts'), 'x', ago(2 * HOUR));
  write(join(tree, '@react-native', 'gradle-plugin', 'shared', 'build', 'tmp', 'jar', 'MANIFEST.MF'));
  write(join(tree, '.pnpm', 'lock.yaml'));
  write(join(tree, '.cache', 'babel', 'entry.json'));
  write(join(tree, '.vitest-cache', 'results.json'));

  expect(await checkDependencyEdits(tree, { level: 'critical', worktree })).toEqual({ delete: true });

  write(join(tree, 'hybrid', 'package.json'), '{"main":"build/index.js"}', ago(2 * HOUR));
  write(join(tree, 'hybrid', 'build.gradle'), 'x', ago(2 * HOUR));
  write(join(tree, 'hybrid', 'build', 'index.js'), 'patched by hand');
  write(join(tree, 'hybrid', 'build', 'tmp', 'x.bin'), 'x', ago(2 * HOUR));

  expect(await keptFiles()).toContain('hybrid/build/index.js');
});

test('a file edited after the install keeps the tree at critical too', async () => {
  installAt(ago(HOUR));
  write(join(tree, 'pkg', 'index.js'), 'patched by hand');

  expect(await keptFiles()).toContain('1 file in it changed after its install (pkg/index.js)');
});

test('with or without a record, an edit stays an edit after a later install rewrites the stamp, while a package that install replaced does not count', async () => {
  for (const recorded of [true, false]) {
    rmSync(tree, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    installAt(ago(0));
    await pause();
    if (recorded) recordDependencyInstall([tree]);
    await pause();
    write(join(tree, 'pkg', 'index.js'), 'patched by hand');
    await pause();
    write(join(tree, 'upgraded', 'package.json'), '{}');
    write(join(tree, 'upgraded', 'index.js'), 'new version');
    await pause();
    writeFileSync(join(tree, '.package-lock.json'), '{"rewritten":true}');

    const kept = await keptFiles();
    expect(kept).toContain('(pkg/index.js)');
    expect(kept).not.toContain('upgraded');
  }
});

test('an edit inside a package added after the first install stays an edit after a later install', async () => {
  installAt(ago(0));
  await pause();
  write(join(tree, 'added', 'package.json'), '{}');
  write(join(tree, 'added', 'index.js'), 'installed');
  await pause(5_200);
  write(join(tree, 'added', 'index.js'), 'patched by hand');
  await pause();
  writeFileSync(join(tree, '.package-lock.json'), '{"rewritten":true}');

  expect(await keptFiles()).toContain('(added/index.js)');
}, 15_000);

test('an edit stays an edit after Stim runs an install that leaves it in place', async () => {
  installAt(ago(2 * HOUR));
  recordDependencyInstall([tree], ago(2 * HOUR).getTime());
  write(join(tree, 'pkg', 'index.js'), 'patched by hand', ago(HOUR));

  await noteEditsBeforeInstall([tree]);
  write(join(tree, '.package-lock.json'), '{}');
  recordDependencyInstall([tree]);

  expect(await keptFiles('high')).toContain('pkg/index.js');
});

test.each([
  { script: false, kept: true },
  { script: true, kept: false },
])(
  'an edit a minute after the stamp, with an install script $script, keeps the tree: $kept',
  async ({ script, kept }) => {
    installAt(ago(2 * 60_000));
    write(join(worktree, 'package.json'), JSON.stringify(script ? { scripts: { postinstall: 'patch-package' } } : {}));
    write(join(tree, 'pkg', 'index.js'), 'patched by hand', ago(60_000));

    expect('keep' in (await checkDependencyEdits(tree, { level: 'critical', worktree }))).toBe(kept);
  },
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a tree is kept when a directory in it cannot be listed, naming it',
  async () => {
    installAt(ago(HOUR));
    write(join(tree, 'pkg', 'locked', 'index.js'), 'patched by hand');
    chmodSync(join(tree, 'pkg', 'locked'), 0o000);

    expect(await keptFiles()).toContain(join(tree, 'pkg', 'locked'));
  },
);
