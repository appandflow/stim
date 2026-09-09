import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../../packages/stim-cli/src/exec.ts';
import { cloneIgnoredEntries } from '../../packages/stim-cli/src/worktree.ts';
import { checkStorageLayout } from '../../packages/stim-cli/src/doctor-storage.ts';

test(
  'warm copies directly on the destination APFS volume despite a temporary override and clone fallback',
  { skip: process.platform !== 'darwin' },
  () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-volumes-e2e-')));
    const image = join(base, 'test.sparseimage');
    const volume = join(base, 'volume');
    const source = join(volume, 'main');
    const previous = Object.fromEntries(
      ['STIM_HOME', 'STIM_TMPDIR', 'STIM_BUILD_CACHE', 'TMPDIR'].map((key) => [key, process.env[key]]),
    );
    const real = getExecutor();
    const run = (file, args) => real.runFile(file, args, { timeoutMs: 30000 });
    const git = (args) => run('git', ['-C', source, ...args]);
    let mounted = false;
    try {
      run('hdiutil', [
        'create',
        '-size',
        '128m',
        '-fs',
        'APFS',
        '-volname',
        'StimVolumeTest',
        '-type',
        'SPARSE',
        image,
      ]);
      run('hdiutil', ['attach', '-nobrowse', '-mountpoint', volume, image]);
      mounted = true;
      assert.notEqual(statSync(volume).dev, statSync(base).dev);
      process.env.STIM_HOME = join(base, 'home');
      process.env.STIM_BUILD_CACHE = join(volume, 'cache');
      process.env.TMPDIR = base;
      process.env.STIM_TMPDIR = base;
      mkdirSync(source);
      git(['init', '-q', '-b', 'main']);
      writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(source, 'package.json'), '{"name":"volume-test"}\n');
      git(['add', '.']);
      git([
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      ]);
      mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(source, 'node_modules', 'pkg', 'index.js'), 'source package');
      for (const fallback of [false, true]) {
        const target = join(volume, `linked-${fallback}`);
        git(['worktree', 'add', '-qb', `linked-${fallback}`, target]);
        setExecutor({
          ...real,
          runFile(file, args, opts) {
            if (file !== 'cp') return real.runFile(file, args, opts);
            assert.equal(args.at(-1), join(target, 'node_modules'));
            assert.equal(statSync(dirname(args.at(-1))).dev, statSync(source).dev);
            if (fallback && args[0] === '-Rc') throw new Error('force clone fallback');
            return real.runFile(file, args, opts);
          },
        });
        const result = cloneIgnoredEntries({ root: source, target, patterns: [] });
        assert.deepEqual(result.failed, []);
        assert.deepEqual(result.copied, ['node_modules']);
        assert.equal(result.cloned, !fallback);
        assert.equal(readFileSync(join(target, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'source package');
      }
      resetExecutor();
      delete process.env.STIM_TMPDIR;
      assert.deepEqual(checkStorageLayout(source, { platform: 'android' }), []);
      process.env.STIM_TMPDIR = base;
      assert.deepEqual(
        checkStorageLayout(source, { platform: 'android' }).map((finding) => finding.title),
        ['Cached app/APK staging crosses filesystems'],
      );
      const crossVolume = join(base, 'linked-other-volume');
      git(['worktree', 'add', '-qb', 'linked-other-volume', crossVolume]);
      const findings = checkStorageLayout(crossVolume, { platform: 'android' });
      const warmFinding = findings.find((finding) => finding.title === 'Worktree copy crosses filesystems');
      assert.ok(warmFinding);
      assert.match(warmFinding.detail, /cannot share file blocks across volumes/);
      assert.match(warmFinding.fix, /main checkout and linked worktree on the same volume/);
    } finally {
      resetExecutor();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (mounted) run('hdiutil', ['detach', volume]);
      rmSync(base, { recursive: true, force: true });
    }
  },
);
